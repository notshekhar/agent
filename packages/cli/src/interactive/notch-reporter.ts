/**
 * notch integration — mirrors the agent-status bus to the notch app's socket
 * so a pane's working / blocked / idle state shows on the MacBook notch, above
 * every app and inside fullscreen. The problem it solves is narrow and real: a
 * background pane that is *blocked* on an approval is invisible until you
 * happen to look at it, and the notch is the one surface that is always in
 * view without being looked for.
 *
 * Shaped as a near-copy of the herdr reporter beside it — same bus, same
 * one-shot-connection-per-report, same ordered queue, same hard timeout — so
 * there is one pattern here to understand, not two.
 *
 * The gate is different, and deliberately so. herdr and cmux inject env into
 * every pane they own; a desktop app cannot. So the gate is the *existence of
 * the socket file*: no socket, no notch, nothing sent. That also makes the
 * integration late-binding — start the notch app after loop and the next
 * transition reports — which env gating could never do.
 *
 * Sends are fire-and-forget: connect, write one line, destroy without waiting
 * for the ack. A dead, wedged or restarted notch must never add latency to a
 * turn or leave the TUI holding a broken socket.
 *
 * Two things ride along that the status bus does not know about, because a
 * row reading "loop · working" is not identifiable when six of them are
 * stacked up. Both are what cmux's sidebar card shows, from the same sources:
 * the session's own name (`session-title.ts` earns it on the first turn, and
 * cmux reads it off the terminal title), and the last thing the agent
 * actually said, which arrives on the `Stop` hook as `last_assistant_message`
 * — the same field cmux titles its turn-complete notification with.
 */
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookBus, type HookPayload } from "@notshekhar/loop-core";
import type { AgentStatusBus, AgentStatusEvent } from "./agent-status";

/** Cap on anything we put on the wire; the notch renders one short line. */
const MAX_TEXT = 300;

function trim(text: string, max = MAX_TEXT): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const SOURCE = "loop";
const AGENT = "loop";
const DEFAULT_SOCKET = join(homedir(), ".notch", "notch.sock");

export interface NotchSessionRef {
    id: string;
    path: string | null;
    /** The session's earned name, which is what the notch labels the row with. */
    name?: string | null;
}

export interface NotchReporterOptions {
    /** Read the live session lazily — called at send time, never cached. */
    getSession: () => NotchSessionRef | null;
    /** Working directory, so the notch can label the row with the repo. */
    cwd: () => string;
    /** The `notch` setting turned the integration off. */
    disabled?: boolean;
    /** Test seams. */
    socketPath?: string;
    connectTimeoutMs?: number;
}

export interface NotchReporter {
    /** Drop the row rather than leaving the notch to time it out. */
    release(): Promise<void>;
}

export function attachNotchReporter(bus: AgentStatusBus, opts: NotchReporterOptions): NotchReporter {
    if (opts.disabled) return { release: () => Promise.resolve() };

    // Same override `notchctl` honours, so a second notch (or a listener you
    // are debugging against) can be pointed at without a rebuild.
    const socketPath = opts.socketPath ?? process.env.NOTCH_SOCKET ?? DEFAULT_SOCKET;
    const connectTimeoutMs = opts.connectTimeoutMs ?? 500;

    // Checked per send, not once at startup: the notch app can be launched or
    // quit at any point in a long session, and a stat on a state transition is
    // far too cheap to be worth caching.
    const listening = (): boolean => {
        try {
            return existsSync(socketPath);
        } catch {
            return false;
        }
    };

    function sendRequest(request: unknown): Promise<void> {
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                socket.destroy();
                resolve();
            };
            const socket = createConnection(socketPath);
            socket.on("error", finish);
            socket.on("connect", () => {
                // Finish from the write callback, not straight after the call:
                // `write` is asynchronous, and destroying the socket before the
                // flush can discard the line entirely.
                socket.write(`${JSON.stringify(request)}\n`, () => finish());
            });
            const timeout = setTimeout(finish, connectTimeoutMs);
            timeout.unref?.();
        });
    }

    let seq = Date.now() * 1000;
    const nextSeq = () => ++seq;
    const requestId = (kind: string) => `${SOURCE}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    // One in flight at a time, order preserved.
    let inFlight = false;
    const queue: (() => Promise<void>)[] = [];
    function enqueue(job: () => Promise<void>): void {
        queue.push(job);
        if (!inFlight) void drain();
    }
    async function drain(): Promise<void> {
        inFlight = true;
        try {
            while (queue.length > 0) {
                const job = queue.shift()!;
                await job();
            }
        } finally {
            inFlight = false;
        }
    }

    let released = false;
    /** The last thing the agent said, carried between turns. */
    let lastSaid = "";

    function report(e: AgentStatusEvent): void {
        if (released || !listening()) return;
        const session = opts.getSession();
        const params: Record<string, unknown> = {
            source: SOURCE,
            agent: AGENT,
            state: e.status,
            cwd: opts.cwd(),
            // So the notch can tell a closed pane from a quiet one. A clean
            // exit sends a release, but a SIGKILL, a crash or a closed
            // terminal window never gets the chance — and a row still claiming
            // "blocked" for a process that no longer exists is worse than no
            // row at all.
            pid: process.pid,
            seq: nextSeq(),
        };
        if (session) params.session_id = session.id;
        if (session?.name) params.title = trim(session.name, 80);
        if (lastSaid) params.say = lastSaid;
        if (e.status === "blocked" && e.label) params.message = e.label;
        enqueue(() => sendRequest({ id: requestId("state"), method: "agent.report", params }));
    }

    // The turn's closing line. Reported immediately rather than waiting for
    // the next state change, because the moment it is worth reading is the
    // moment the turn ends and you are not looking at the pane.
    function onHookEvent(payload: HookPayload): void {
        if (released || payload.hook_event_name !== "Stop") return;
        const said = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
        if (!said) return;
        lastSaid = trim(said);
        report(bus.current());
    }

    hookBus.on("event", onHookEvent);
    bus.on(report);
    // Announce presence immediately so the row appears at launch rather than
    // at the first transition.
    report(bus.current());

    return {
        release() {
            if (released) return Promise.resolve();
            released = true;
            hookBus.off("event", onHookEvent);
            if (!listening()) return Promise.resolve();
            const session = opts.getSession();
            const params: Record<string, unknown> = { source: SOURCE, seq: nextSeq() };
            if (session) params.session_id = session.id;
            return new Promise((resolve) => {
                enqueue(async () => {
                    await sendRequest({ id: requestId("release"), method: "agent.release", params });
                    resolve();
                });
            });
        },
    };
}
