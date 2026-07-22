/**
 * herdr integration — mirrors the agent-status bus to herdr's socket API
 * when loop runs inside a herdr pane (https://herdr.dev). herdr is an agent
 * multiplexer whose sidebar shows every pane as working / blocked / idle;
 * without a report it can only see loop as a plain terminal process. This
 * consumer speaks pane.report_agent / pane.report_agent_session /
 * pane.release_agent as a "custom" source — the documented path for agents
 * without an official herdr integration — so the pane shows "loop" with
 * live semantic state.
 *
 * Hard-gated on the env herdr injects into every pane (HERDR_ENV=1 +
 * HERDR_SOCKET_PATH + HERDR_PANE_ID): outside herdr the reporter never
 * subscribes and never opens a socket. Sends are fire-and-forget over a
 * short-lived unix-socket connection with a hard timeout — a dead or
 * restarted herdr server must never add latency, errors, or reconnect state
 * to the TUI. A send queue keeps reports in order; session identity rides
 * every report and is re-announced when the session id changes (covers
 * create, /new, /resume, forks through the one getter).
 */
import { createConnection } from "node:net";
import type { AgentStatusBus, AgentStatusEvent } from "./agent-status";

const SOURCE = "custom:loop";
const AGENT = "loop";

export interface HerdrSessionRef {
    id: string;
    path: string | null;
}

export interface HerdrReporterOptions {
    /** Read the live session lazily — called at send time, never cached. */
    getSession: () => HerdrSessionRef | null;
    /** The `herdr` setting turned the integration off. */
    disabled?: boolean;
    /** Test seams — default to process.env and production timings. */
    env?: NodeJS.ProcessEnv;
    connectTimeoutMs?: number;
}

export interface HerdrReporter {
    /** True when running inside a herdr pane with reporting enabled. */
    readonly active: boolean;
    /** Hand the pane back to herdr's own detection on exit. Bounded-time. */
    release(): Promise<void>;
}

export function attachHerdrReporter(bus: AgentStatusBus, opts: HerdrReporterOptions): HerdrReporter {
    const env = opts.env ?? process.env;
    const socketPath = env.HERDR_SOCKET_PATH;
    const paneId = env.HERDR_PANE_ID;
    const active = !opts.disabled && env.HERDR_ENV === "1" && !!socketPath && !!paneId;
    const connectTimeoutMs = opts.connectTimeoutMs ?? 500;

    if (!active) return { active, release: () => Promise.resolve() };

    // One shot per request: connect, write a line, wait briefly for the ack,
    // destroy. No persistent connection — survives herdr server restarts and
    // can never leave the TUI holding a broken socket.
    function sendRequest(request: unknown): Promise<void> {
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                socket.destroy();
                resolve();
            };
            const socket = createConnection(socketPath!);
            socket.on("error", finish);
            socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
            socket.on("data", finish);
            socket.on("end", finish);
            const timeout = setTimeout(finish, connectTimeoutMs);
            timeout.unref?.();
        });
    }

    let reportSeq = Date.now() * 1000;
    const nextSeq = () => ++reportSeq;
    const requestId = (kind: string) => `${SOURCE}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    // Send queue: one in flight at a time, order preserved.
    let sendInFlight = false;
    const sendQueue: (() => Promise<void>)[] = [];
    function enqueue(job: () => Promise<void>): void {
        sendQueue.push(job);
        if (!sendInFlight) void drain();
    }
    async function drain(): Promise<void> {
        sendInFlight = true;
        try {
            while (sendQueue.length > 0) {
                const job = sendQueue.shift()!;
                await job();
            }
        } finally {
            sendInFlight = false;
        }
    }

    // Session identity attached to every report; re-announced on id change.
    let announcedSessionId: string | undefined;
    function sessionParams(): Record<string, string> {
        const s = opts.getSession();
        if (!s) return {};
        const params: Record<string, string> = { agent_session_id: s.id };
        if (s.path) params.agent_session_path = s.path;
        return params;
    }

    function announceSessionIfChanged(): void {
        const s = opts.getSession();
        if (!s || s.id === announcedSessionId) return;
        announcedSessionId = s.id;
        const params = { pane_id: paneId, source: SOURCE, agent: AGENT, seq: nextSeq(), ...sessionParams() };
        enqueue(() => sendRequest({ id: requestId("session"), method: "pane.report_agent_session", params }));
    }

    let released = false;

    function report(e: AgentStatusEvent): void {
        if (released) return;
        announceSessionIfChanged();
        const params = {
            pane_id: paneId,
            source: SOURCE,
            agent: AGENT,
            state: e.status,
            ...(e.status === "blocked" && e.label ? { message: e.label } : {}),
            seq: nextSeq(),
            ...sessionParams(),
        };
        enqueue(() => sendRequest({ id: requestId("state"), method: "pane.report_agent", params }));
    }

    bus.on(report);
    // Announce presence right away: the pane shows "loop · idle" from launch
    // instead of waiting for the first transition.
    report(bus.current());

    return {
        active,
        release() {
            if (released) return Promise.resolve();
            released = true;
            const params = { pane_id: paneId, source: SOURCE, agent: AGENT, seq: nextSeq() };
            // Through the queue so it lands after any in-flight state report.
            return new Promise((resolve) => {
                enqueue(async () => {
                    await sendRequest({ id: requestId("release"), method: "pane.release_agent", params });
                    resolve();
                });
            });
        },
    };
}
