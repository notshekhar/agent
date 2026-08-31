/**
 * notch reporter (notch-reporter.ts) against a real unix socket standing in
 * for the notch app, asserting the exact `agent.report` frames it would
 * receive for a scripted session.
 *
 * The frames are the contract — the notch's `AgentsModule` reads `state`,
 * `message`, `title`, `say`, `pid` and `seq` off them, and a row that says
 * the wrong thing is worse than no row, because the whole point of the
 * integration is being trusted at a glance. The socket-existence gate is here
 * for the same reason the env gate is in the herdr and cmux tests: with the
 * notch not running, this must be completely inert.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookBus, type HookPayload } from "@notshekhar/loop-core";
import { createAgentStatusBus } from "../src/interactive/agent-status";
import { attachNotchReporter, type NotchReporter } from "../src/interactive/notch-reporter";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame {
    id: string;
    method: string;
    params: Record<string, unknown>;
}

/** The notch's side: accept a connection, read one line, hang up. */
function fakeNotch(socketPath: string): { frames: Frame[]; server: Server } {
    const frames: Frame[] = [];
    const server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString();
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (line) frames.push(JSON.parse(line) as Frame);
            }
        });
        socket.on("error", () => socket.destroy());
    });
    server.listen(socketPath);
    return { frames, server };
}

/** Poll for the frame count to settle: sends are queued and fire-and-forget. */
async function frameCount(frames: Frame[], n: number, deadlineMs = 3_000): Promise<void> {
    const end = Date.now() + deadlineMs;
    while (frames.length < n) {
        if (Date.now() > end) throw new Error(`only ${frames.length} of ${n} frames arrived`);
        await tick(20);
    }
}

let dir: string | undefined;
let server: Server | undefined;
let reporter: NotchReporter | undefined;

afterEach(async () => {
    await reporter?.release();
    reporter = undefined;
    server?.close();
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
});

function setup(opts: { listening: boolean }) {
    dir = mkdtempSync(join(tmpdir(), "loop-notch-"));
    const socketPath = join(dir, "notch.sock");
    const notch = opts.listening ? fakeNotch(socketPath) : { frames: [] as Frame[], server: undefined };
    server = notch.server;
    const bus = createAgentStatusBus(10);
    return { socketPath, frames: notch.frames, bus };
}

describe("notch reporter", () => {
    test("announces itself on attach, then on every transition", async () => {
        const { socketPath, frames, bus } = setup({ listening: true });
        reporter = attachNotchReporter(bus, {
            getSession: () => ({ id: "sess-1", path: null, name: "fixing the parser" }),
            cwd: () => "/tmp/repo",
            socketPath,
        });

        // The row has to exist before anything happens, or a session that sits
        // idle at a prompt is invisible until it does something.
        await frameCount(frames, 1);
        expect(frames[0]?.method).toBe("agent.report");
        expect(frames[0]?.params).toMatchObject({
            source: "loop",
            agent: "loop",
            state: "idle",
            cwd: "/tmp/repo",
            session_id: "sess-1",
            title: "fixing the parser",
            pid: process.pid,
        });

        bus.setWorking();
        await frameCount(frames, 2);
        expect(frames[1]?.params.state).toBe("working");

        // seq is what lets the notch drop a report that arrives out of order.
        const seqs = frames.map((f) => f.params.seq as number);
        expect(seqs[1]).toBeGreaterThan(seqs[0]!);
    });

    test("a blocked agent carries what it is blocked on", async () => {
        const { socketPath, frames, bus } = setup({ listening: true });
        reporter = attachNotchReporter(bus, {
            getSession: () => ({ id: "sess-2", path: null }),
            cwd: () => "/tmp/repo",
            socketPath,
        });
        await frameCount(frames, 1);

        bus.modalOpened("bash approval");
        await frameCount(frames, 2);
        // The label is the entire value of the notification: "loop · blocked"
        // is not actionable, "blocked · bash approval" is.
        expect(frames[1]?.params).toMatchObject({ state: "blocked", message: "bash approval" });
    });

    test("the turn's closing line rides along, and keeps riding", async () => {
        const { socketPath, frames, bus } = setup({ listening: true });
        reporter = attachNotchReporter(bus, {
            getSession: () => ({ id: "sess-3", path: null }),
            cwd: () => "/tmp/repo",
            socketPath,
        });
        await frameCount(frames, 1);
        expect(frames[0]?.params.say).toBeUndefined();

        const payload: HookPayload = {
            hook_event_name: "Stop",
            last_assistant_message: "  Renamed the flag   and updated the docs.  ",
        } as HookPayload;
        hookBus.emit("event", payload);

        // Reported straight away rather than at the next transition: the
        // moment it is worth reading is the moment you stopped watching.
        await frameCount(frames, 2);
        expect(frames[1]?.params.say).toBe("Renamed the flag and updated the docs.");

        // It is the last thing said, not a one-shot event — the row keeps it
        // until the agent says something else.
        bus.setWorking();
        await frameCount(frames, 3);
        expect(frames[2]?.params.say).toBe("Renamed the flag and updated the docs.");
    });

    test("release drops the row instead of leaving it to time out", async () => {
        const { socketPath, frames, bus } = setup({ listening: true });
        reporter = attachNotchReporter(bus, {
            getSession: () => ({ id: "sess-4", path: null }),
            cwd: () => "/tmp/repo",
            socketPath,
        });
        await frameCount(frames, 1);

        await reporter.release();
        reporter = undefined;
        await frameCount(frames, 2);
        expect(frames[1]?.method).toBe("agent.release");
        expect(frames[1]?.params).toMatchObject({ source: "loop", session_id: "sess-4" });

        // After release the bus is still live (nothing can unsubscribe from
        // it), so the guard has to hold — a released row must stay gone.
        bus.setWorking();
        await tick(150);
        expect(frames).toHaveLength(2);
    });

    test("no socket, no notch: nothing is connected to and nothing is created", async () => {
        const { socketPath, bus } = setup({ listening: false });
        reporter = attachNotchReporter(bus, {
            getSession: () => ({ id: "sess-5", path: null }),
            cwd: () => "/tmp/repo",
            socketPath,
        });
        bus.setWorking();
        bus.modalOpened("question");
        await tick(150);
        // The producer must never bring the socket into existence — the notch
        // owns it, and a file here would make every other producer think the
        // notch was running.
        expect(existsSync(socketPath)).toBe(false);
        // Release on a socket that never existed must resolve, not hang: the
        // exit path awaits it.
        const started = Date.now();
        await reporter.release();
        reporter = undefined;
        expect(Date.now() - started).toBeLessThan(500);
    });

    test("a stale socket file does not hang the exit path", async () => {
        // The gate is the file's existence, so a notch that crashed leaves
        // exactly this behind: a path that stats fine and refuses every
        // connection. Sends are fire-and-forget precisely so this costs a turn
        // nothing, and the timeout is what makes that true.
        const { socketPath, bus } = setup({ listening: false });
        writeFileSync(socketPath, "");
        reporter = attachNotchReporter(bus, {
            getSession: () => ({ id: "sess-6", path: null }),
            cwd: () => "/tmp/repo",
            socketPath,
            connectTimeoutMs: 100,
        });
        bus.setWorking();
        const started = Date.now();
        await reporter.release();
        reporter = undefined;
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    test("the socket is checked per send, so a late notch still gets the row", async () => {
        const { socketPath, bus } = setup({ listening: false });
        reporter = attachNotchReporter(bus, {
            getSession: () => ({ id: "sess-7", path: null }),
            cwd: () => "/tmp/repo",
            socketPath,
        });
        bus.setWorking();
        await tick(50);

        // This is what the existence gate buys over an env gate: a desktop app
        // cannot inject env into a terminal that is already running.
        const late = fakeNotch(socketPath);
        server = late.server;
        bus.modalOpened("question");
        await frameCount(late.frames, 1);
        // Only the transition that happened while it was listening — the
        // earlier idle and working reports were dropped, not queued for a
        // notch that might never arrive.
        expect(late.frames).toHaveLength(1);
        expect(late.frames[0]?.params.state).toBe("blocked");
    });

    test("the setting turns it off entirely", async () => {
        const { socketPath, frames, bus } = setup({ listening: true });
        reporter = attachNotchReporter(bus, {
            getSession: () => ({ id: "sess-8", path: null }),
            cwd: () => "/tmp/repo",
            socketPath,
            disabled: true,
        });
        bus.setWorking();
        await tick(150);
        expect(frames).toHaveLength(0);
    });
});
