/**
 * Agent-status bus (agent-status.ts) + herdr reporter (herdr-reporter.ts).
 * The bus is exercised directly; the reporter runs against a real unix
 * socket server (Bun.listen) standing in for herdr, asserting the exact
 * JSON-RPC requests herdr would receive for a scripted lifecycle. The env
 * gate and dead-socket behavior are covered because they are the safety
 * story: outside herdr (or with herdr gone) the reporter must be inert.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createAgentStatusBus, type AgentStatusEvent } from "../src/interactive/agent-status";
import { attachHerdrReporter, type HerdrSessionRef } from "../src/interactive/herdr-reporter";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("agent status bus", () => {
    test("upward transitions emit immediately, downward settle", async () => {
        const bus = createAgentStatusBus(30);
        const events: AgentStatusEvent[] = [];
        bus.on((e) => events.push(e));

        bus.setWorking();
        expect(events).toEqual([{ status: "working" }]);

        const close = bus.modalOpened("bash approval");
        expect(events[1]).toEqual({ status: "blocked", label: "bash approval" });

        // Downward (blocked → working) waits out the settle window.
        close();
        expect(events).toHaveLength(2);
        await tick(60);
        expect(events[2]).toEqual({ status: "working" });

        bus.setIdle();
        await tick(60);
        expect(events[3]).toEqual({ status: "idle" });
    });

    test("flicker inside the settle window is suppressed", async () => {
        const bus = createAgentStatusBus(30);
        const events: AgentStatusEvent[] = [];
        bus.on((e) => events.push(e));

        // Ask flow: selector per question — close then reopen immediately.
        const close1 = bus.modalOpened("question: A");
        close1();
        const close2 = bus.modalOpened("question: A");
        await tick(60);
        // One blocked emit total: the close never surfaced.
        expect(events).toEqual([{ status: "blocked", label: "question: A" }]);
        close2();
        await tick(60);
        expect(events[1]).toEqual({ status: "idle" });
    });

    test("queued-turn gap (idle→working flap) is suppressed", async () => {
        const bus = createAgentStatusBus(30);
        const events: AgentStatusEvent[] = [];
        bus.setWorking();
        bus.on((e) => events.push(e));

        bus.setIdle();
        bus.setWorking();
        await tick(60);
        expect(events).toEqual([]);
    });

    test("blocked wins over working; label changes re-emit", () => {
        const bus = createAgentStatusBus(30);
        const events: AgentStatusEvent[] = [];
        bus.on((e) => events.push(e));

        bus.setWorking();
        const closeOuter = bus.modalOpened("question: X");
        const closeInner = bus.modalOpened("bash approval");
        expect(events.map((e) => e.label ?? e.status)).toEqual(["working", "question: X", "bash approval"]);
        closeInner();
        closeOuter();
        expect(bus.current().status).toBe("blocked"); // settle pending
    });

    test("closer is idempotent", async () => {
        const bus = createAgentStatusBus(10);
        const close = bus.modalOpened("question");
        close();
        close();
        await tick(30);
        expect(bus.current().status).toBe("idle");
        // A later modal still balances correctly after the double-close.
        bus.modalOpened("question");
        expect(bus.current().status).toBe("blocked");
    });
});

/** Line-delimited JSON-RPC server on a unix socket, ack-ing every request. */
function fakeHerdrServer(socketPath: string) {
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    const server = Bun.listen({
        unix: socketPath,
        socket: {
            data(socket, data) {
                for (const line of data.toString().split("\n")) {
                    if (!line.trim()) continue;
                    const req = JSON.parse(line);
                    requests.push({ method: req.method, params: req.params });
                    socket.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
                }
            },
        },
    });
    return { requests, stop: () => server.stop(true) };
}

describe("herdr reporter", () => {
    let dir: string | undefined;
    let stop: (() => void) | undefined;
    afterEach(() => {
        stop?.();
        stop = undefined;
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    const herdrEnv = (socketPath: string): NodeJS.ProcessEnv => ({
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: socketPath,
        HERDR_PANE_ID: "w1:p1",
    });

    test("reports lifecycle to the socket with session identity", async () => {
        dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
        const socketPath = join(dir, "herdr.sock");
        const server = fakeHerdrServer(socketPath);
        stop = server.stop;

        let session: HerdrSessionRef | null = null;
        const bus = createAgentStatusBus(10);
        const reporter = attachHerdrReporter(bus, { getSession: () => session, env: herdrEnv(socketPath) });
        expect(reporter.active).toBe(true);

        session = { id: "abc123", path: "/tmp/abc123.jsonl" };
        bus.setWorking();
        const close = bus.modalOpened("bash approval");
        close();
        bus.setIdle();
        await tick(40);
        await reporter.release();

        expect(server.requests.map((r) => r.method)).toEqual([
            "pane.report_agent", // initial idle announce (pre-session)
            "pane.report_agent_session", // session appeared with first turn
            "pane.report_agent", // working
            "pane.report_agent", // blocked
            "pane.report_agent", // idle (settled; blocked→working flap merged)
            "pane.release_agent",
        ]);

        const [, sessionReq, working, blocked, idle] = server.requests;
        expect(sessionReq.params).toMatchObject({
            pane_id: "w1:p1",
            source: "custom:loop",
            agent: "loop",
            agent_session_id: "abc123",
            agent_session_path: "/tmp/abc123.jsonl",
        });
        expect(working.params).toMatchObject({ state: "working", agent_session_id: "abc123" });
        expect(blocked.params).toMatchObject({ state: "blocked", message: "bash approval" });
        expect(idle.params).toMatchObject({ state: "idle" });

        // seq strictly increases across all reports.
        const seqs = server.requests.map((r) => r.params.seq as number);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
        expect(new Set(seqs).size).toBe(seqs.length);
    });

    test("session change is re-announced", async () => {
        dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
        const socketPath = join(dir, "herdr.sock");
        const server = fakeHerdrServer(socketPath);
        stop = server.stop;

        let session: HerdrSessionRef | null = { id: "one", path: null };
        const bus = createAgentStatusBus(10);
        attachHerdrReporter(bus, { getSession: () => session, env: herdrEnv(socketPath) });

        bus.setWorking();
        session = { id: "two", path: null };
        bus.modalOpened("question");
        await tick(40);

        const announces = server.requests.filter((r) => r.method === "pane.report_agent_session");
        expect(announces.map((r) => r.params.agent_session_id)).toEqual(["one", "two"]);
    });

    test("inert outside herdr: no socket traffic, no subscription", () => {
        const bus = createAgentStatusBus(10);
        const reporter = attachHerdrReporter(bus, { getSession: () => null, env: {} });
        expect(reporter.active).toBe(false);
        // Missing any one of the three vars → inert.
        for (const env of [
            { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/x.sock" },
            { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
            { HERDR_SOCKET_PATH: "/tmp/x.sock", HERDR_PANE_ID: "w1:p1" },
        ]) {
            expect(attachHerdrReporter(bus, { getSession: () => null, env }).active).toBe(false);
        }
        // Setting opt-out wins even inside herdr.
        const disabled = attachHerdrReporter(bus, {
            getSession: () => null,
            disabled: true,
            env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/x.sock", HERDR_PANE_ID: "w1:p1" },
        });
        expect(disabled.active).toBe(false);
    });

    test("dead socket: reports resolve without throwing", async () => {
        dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
        const socketPath = join(dir, "gone.sock"); // never listened on
        const bus = createAgentStatusBus(10);
        const reporter = attachHerdrReporter(bus, {
            getSession: () => null,
            env: herdrEnv(socketPath),
            connectTimeoutMs: 50,
        });
        expect(reporter.active).toBe(true);
        bus.setWorking();
        bus.modalOpened("question");
        await reporter.release(); // resolves despite no server
    });
});
