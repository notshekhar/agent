/**
 * Pidfile bookkeeping for gateway daemons. Every gateway runs as its own
 * detached OS process — never inside the TUI — so its liveness must be
 * discoverable across processes: the TUI spawns and stops it, `loop gateways
 * status` reports it, and a foreground runner refuses to start a second poller.
 * One pidfile per gateway under the config dir, mirroring the RPC socket
 * daemon's pattern (server.ts).
 */
import { getConfigDir } from "../brand";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** The daemon's pid if that process is still alive, else null (stale/absent). */
export function liveGatewayPid(id: string): number | null {
    const path = gatewayPidPath(id);
    if (!existsSync(path)) return null;
    const pid = Number(readFileSync(path, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        process.kill(pid, 0); // signal 0 = existence check only
        return pid;
    } catch {
        return null;
    }
}

export function isGatewayRunning(id: string): boolean {
    return liveGatewayPid(id) !== null;
}

/** Claim the pidfile for the current process. Throws if a live daemon already
 * owns it — a second poller would fight the first (e.g. Telegram's 409). */
export function claimGatewayPid(id: string): void {
    const existing = liveGatewayPid(id);
    if (existing) throw new Error(`gateway ${id} daemon already running (pid ${existing})`);
    writeFileSync(gatewayPidPath(id), String(process.pid));
}

export function clearGatewayPid(id: string): void {
    try {
        unlinkSync(gatewayPidPath(id));
    } catch {}
}

/** Remove the pidfile only if THIS process owns it — a daemon shutting down
 * must never delete the pidfile of a replacement that already claimed it. */
export function clearOwnGatewayPid(id: string): void {
    try {
        const pid = Number(readFileSync(gatewayPidPath(id), "utf8").trim());
        if (pid !== process.pid) return;
    } catch {
        return; // already gone
    }
    clearGatewayPid(id);
}

/** Stop a running gateway daemon via SIGTERM; cleans up a stale pidfile. */
export function stopGatewayDaemon(id: string): { stopped: boolean; pid?: number } {
    const pid = liveGatewayPid(id);
    if (!pid) {
        clearGatewayPid(id);
        return { stopped: false };
    }
    try {
        process.kill(pid, "SIGTERM");
    } catch {}
    return { stopped: true, pid };
}
