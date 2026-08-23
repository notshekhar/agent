/**
 * Pidfile bookkeeping for gateways. A gateway's liveness has to be discoverable
 * across processes — the TUI must not start a second poller, `loop gateways
 * status` reports it, and a foreground runner refuses to fight an existing one
 * — so ownership lives in a file, one per gateway under the config dir.
 *
 * The record carries HOW it runs, not just the pid. A gateway normally runs
 * inside the loop process that owns it ("in-process"); `loop gateways` can
 * still fork a detached one ("daemon"). The distinction is load-bearing for
 * stopGatewayDaemon: SIGTERM is right for a daemon whose only job is the
 * gateway, and catastrophic for an in-process owner, where that pid is a whole
 * interactive loop the user is sitting in front of.
 */
import { getConfigDir } from "../brand";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How the process holding the pidfile runs the gateway. */
export type GatewayOwnerMode = "in-process" | "daemon";

export interface GatewayOwner {
    pid: number;
    mode: GatewayOwnerMode;
}

function daemonDir(): string {
    const dir = join(getConfigDir(), "agent");
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function gatewayPidPath(id: string): string {
    return join(daemonDir(), `gateway-${id}.pid`);
}

/** Where a spawned daemon's stdout/stderr are appended, for debugging. */
export function gatewayLogPath(id: string): string {
    return join(daemonDir(), `gateway-${id}.log`);
}

/** Parse a pidfile's contents. Tolerates the legacy bare-integer format: a
 * pidfile written by an older loop that is still running must not read as
 * corrupt, and back then every gateway was a detached daemon. Pure, so the
 * format's edges are pinned by tests rather than by a live daemon. */
export function parseGatewayOwner(raw: string): GatewayOwner | null {
    const text = raw.trim();
    if (!text) return null;
    let pid: number;
    let mode: GatewayOwnerMode = "daemon";
    if (text.startsWith("{")) {
        try {
            const parsed = JSON.parse(text) as { pid?: unknown; mode?: unknown };
            pid = Number(parsed.pid);
            if (parsed.mode === "in-process" || parsed.mode === "daemon") mode = parsed.mode;
        } catch {
            return null;
        }
    } else {
        pid = Number(text);
    }
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, mode };
}

/** The owning process if it's still alive, else null (stale/absent/garbage). */
export function liveGatewayOwner(id: string): GatewayOwner | null {
    const path = gatewayPidPath(id);
    if (!existsSync(path)) return null;
    let owner: GatewayOwner | null;
    try {
        owner = parseGatewayOwner(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
    if (!owner) return null;
    try {
        process.kill(owner.pid, 0); // signal 0 = existence check only
        return owner;
    } catch {
        return null;
    }
}

/** The owning pid if that process is still alive, else null (stale/absent). */
export function liveGatewayPid(id: string): number | null {
    return liveGatewayOwner(id)?.pid ?? null;
}

export function isGatewayRunning(id: string): boolean {
    return liveGatewayOwner(id) !== null;
}

/** True when this very process is the one serving the gateway. Distinguishes
 * "someone else is polling, leave it alone" from "that's us". */
export function ownsGateway(id: string): boolean {
    return liveGatewayOwner(id)?.pid === process.pid;
}

/** Claim the pidfile for the current process. Throws if a live owner already
 * holds it — a second poller would fight the first (e.g. Telegram's 409). */
export function claimGatewayPid(id: string, mode: GatewayOwnerMode = "daemon"): void {
    const existing = liveGatewayOwner(id);
    if (existing) {
        const how = existing.mode === "in-process" ? "inside a running loop" : "as a daemon";
        throw new Error(`gateway ${id} already running ${how} (pid ${existing.pid})`);
    }
    writeFileSync(gatewayPidPath(id), JSON.stringify({ pid: process.pid, mode }));
}

export function clearGatewayPid(id: string): void {
    try {
        unlinkSync(gatewayPidPath(id));
    } catch {}
}

/** Remove the pidfile only if THIS process owns it — a process shutting down
 * must never delete the pidfile of a replacement that already claimed it. */
export function clearOwnGatewayPid(id: string): void {
    const owner = (() => {
        try {
            return parseGatewayOwner(readFileSync(gatewayPidPath(id), "utf8"));
        } catch {
            return null; // already gone
        }
    })();
    if (!owner || owner.pid !== process.pid) return;
    clearGatewayPid(id);
}

export interface StopGatewayResult {
    stopped: boolean;
    pid?: number;
    /** Set when the owner runs the gateway inside a bigger process, so signalling
     * it would take that process down with it. Nothing was signalled. */
    refusedInProcess?: boolean;
}

/**
 * Stop a gateway owned by a *detached daemon*, via SIGTERM; cleans up a stale
 * pidfile. An in-process owner is deliberately left alone and reported instead:
 * that pid is an entire loop, and killing a user's editor to turn off a chat
 * bridge is never what "stop the gateway" meant. Toggle it off in /gateways (or
 * quit that loop) to stop an in-process one.
 */
export function stopGatewayDaemon(id: string): StopGatewayResult {
    const owner = liveGatewayOwner(id);
    if (!owner) {
        clearGatewayPid(id);
        return { stopped: false };
    }
    if (owner.mode === "in-process") {
        return { stopped: false, pid: owner.pid, refusedInProcess: true };
    }
    try {
        process.kill(owner.pid, "SIGTERM");
    } catch {}
    return { stopped: true, pid: owner.pid };
}
