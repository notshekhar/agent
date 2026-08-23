/**
 * Gateway lifecycle inside the TUI. Gateways run IN THIS PROCESS: enabled ones
 * come up with loop and stop when it exits, so a phone bridge never outlives
 * the loop that owns it and there is no detached process to leak.
 *
 * They were separate detached daemons before. Nothing about a gateway needed
 * that — the Telegram bridge is a 50s long-poll driving its own in-process
 * RpcServer, i.e. idle I/O, the same shape `loop serve` already hosts — while
 * the costs were real: a daemon that missed its shutdown signal kept polling
 * (and running shell commands) forever, and each one re-invoked the whole loop
 * binary just to sit in a socket read.
 *
 * The pidfile stays, because the single-poller lock is cross-process (Telegram
 * allows exactly one getUpdates consumer per token and 409s the rest). It now
 * records this loop's own pid, marked "in-process" so `loop gateways stop`
 * reports it instead of SIGTERMing the user's editor.
 */
import {
    claimGatewayPid,
    clearOwnGatewayPid,
    isGatewayRunning,
    listEnabledGateways,
    liveGatewayOwner,
    type Gateway,
    type GatewayHandle,
} from "@notshekhar/loop-core";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";
import { dim } from "./ui/text";

/** Live gateways this process is serving, by id — what we stop on exit. */
const running = new Map<string, GatewayHandle>();

export function isGatewayRunningHere(id: string): boolean {
    return running.has(id);
}

/**
 * Start one gateway in this process. Returns what happened so callers can
 * report it; never throws, because no gateway failure is worth taking the TUI
 * (or its startup) down with it.
 */
export async function startGatewayHere(
    gw: Gateway,
    state: AppState,
    deps: AppDeps,
): Promise<"started" | "already-running" | "error"> {
    if (running.has(gw.id)) return "already-running";
    // Someone else's loop (or a detached daemon) is already polling this token.
    // Theirs to own; a second poller would just fight it.
    if (isGatewayRunning(gw.id)) return "already-running";
    try {
        // Claim before starting: the window between "decided to start" and
        // "polling" is exactly when a second loop would also decide to start.
        claimGatewayPid(gw.id, "in-process");
    } catch {
        return "already-running"; // lost the race to another loop
    }
    try {
        const handle = await gw.start({
            cwd: state.cwd || process.cwd(),
            // Gateway diagnostics are low-frequency (pairing, poll errors) and
            // belong in the transcript now that there's no logfile to tail.
            log: (line) => {
                deps.history.addSystem(dim(`${gw.id}: ${line}`));
                deps.tui.requestRender();
            },
        });
        running.set(gw.id, handle);
        return "started";
    } catch (err) {
        // Starting failed, so we are not the owner — release the claim, or the
        // next loop to try would be told a dead gateway is already running.
        clearOwnGatewayPid(gw.id);
        deps.history.addSystem(dim(`${gw.id}: ${(err as Error).message}`));
        return "error";
    }
}

/** Stop one gateway running in this process. No-op if we aren't serving it. */
export function stopGatewayHere(id: string): boolean {
    const handle = running.get(id);
    if (!handle) return false;
    running.delete(id);
    try {
        handle.stop();
    } catch {
        // A gateway that throws on the way down must not block the next step.
    }
    clearOwnGatewayPid(id);
    return true;
}

/**
 * Bring up every enabled gateway in this process. Fire-and-forget at launch:
 * awaited nowhere on the startup path, and a failure is surfaced in the
 * transcript rather than blocking the UI.
 */
export function startEnabledGateways(state: AppState, deps: AppDeps): void {
    void (async () => {
        for (const gw of listEnabledGateways()) {
            const result = await startGatewayHere(gw, state, deps);
            if (result === "started") {
                deps.history.addSystem(dim(`${gw.id}: running in this loop (stops when loop exits)`));
            } else if (result === "already-running") {
                const owner = liveGatewayOwner(gw.id);
                // Only worth a line when someone ELSE has it — otherwise this
                // is just a second call for a gateway we already serve.
                if (owner && owner.pid !== process.pid) {
                    deps.history.addSystem(dim(`${gw.id}: already served by pid ${owner.pid} — left alone`));
                }
            }
        }
        deps.tui.requestRender();
    })();
}

/** Stop every gateway this loop is serving. Best-effort: called on the exit
 * path, where nothing may throw and nothing may block. */
export function stopRunningGateways(): void {
    for (const id of [...running.keys()]) {
        try {
            stopGatewayHere(id);
        } catch {
            // Never let a dying gateway hold up the TUI's exit path.
        }
    }
    running.clear();
}
