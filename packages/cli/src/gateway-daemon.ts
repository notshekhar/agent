/**
 * The detached-daemon path for gateways: `loop gateways` with no arguments,
 * which deliberately backgrounds every enabled gateway and returns the shell.
 *
 * This is no longer how loop itself runs gateways — the TUI hosts them in its
 * own process (see interactive/gateway-process.ts), so nothing is forked on
 * startup and nothing outlives the loop that owns it. What remains here is the
 * explicit request: the user asked for a bridge that keeps polling after the
 * terminal closes, and stops it with `loop gateways stop`.
 *
 * - spawnGatewayDaemon: fork `loop gateways <id>` detached, pidfile-guarded
 *   (never two pollers) with a logfile for its output.
 * - runGatewayForeground: the daemon body itself — claims the pidfile, starts
 *   the gateway, and blocks until signalled.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { basename } from "node:path";
import {
    claimGatewayPid,
    clearOwnGatewayPid,
    gatewayLogPath,
    getGateway,
    isGatewayRunning,
    type GatewayStartOpts,
} from "@notshekhar/loop-core";

/** Marks a process as a gateway daemon, so it never spawns gateways itself. */
export const GATEWAY_DAEMON_ENV = "LOOP_GATEWAY_DAEMON";

/** How to re-invoke this same loop with extra args. A compiled binary runs
 * itself with the args; under `bun <entry>` the entry script must lead.
 *
 * Decided from the executable, never from the entry path: inside a compiled Bun
 * binary the entry is the virtual "/$bunfs/root/cli.js", which any `.js` test
 * reads as "running from source". The daemon then got spawned as
 * `loop /$bunfs/root/cli.js gateways telegram`, whose command word is the bunfs
 * path — no such command, so it fell through to the interactive TUI, which back
 * then spawned daemons for enabled gateways on startup… which fell through to a
 * TUI, one new process every ~1.5s until the machine filled up. Pure so the
 * shape of that spawn is pinned by a test; goals/daemon.ts does the same check. */
export function daemonInvocation(exe: string, entry: string, extra: string[]): { command: string; args: string[] } {
    const underBun = basename(exe).toLowerCase().startsWith("bun");
    return { command: exe, args: underBun ? [entry, ...extra] : extra };
}

function selfInvocation(extra: string[]): { command: string; args: string[] } {
    return daemonInvocation(process.execPath, Bun.main ?? process.argv[1] ?? "", extra);
}

export type SpawnResult = "spawned" | "already-running" | "error" | "refused-nested";

/** Fork the gateway's daemon as a detached, separate process. No-op if one is
 * already live (the pidfile guard). Output goes to the gateway's logfile. Such
 * a daemon has no owner and runs until `loop gateways stop`.
 *
 * The nested check is the load-bearing one. Getting the invocation wrong made a
 * "daemon" land in the interactive TUI, and a TUI back then spawned daemons on
 * startup — 212 processes before anyone noticed. The TUI no longer spawns
 * anything, which removes that particular cycle, and selfInvocation is correct;
 * this is what makes the chain structurally impossible rather than merely
 * fixed: a process running as a gateway daemon cannot spawn a gateway daemon,
 * so any such recursion terminates at depth one no matter what else breaks.
 * Enforced here, at the single choke point, so no call site can forget it. */
export function spawnGatewayDaemon(id: string): SpawnResult {
    if (process.env[GATEWAY_DAEMON_ENV]) return "refused-nested";
    if (isGatewayRunning(id)) return "already-running";
    try {
        const { command, args } = selfInvocation(["gateways", id]);
        const out = openSync(gatewayLogPath(id), "a");
        const env: NodeJS.ProcessEnv = { ...process.env, [GATEWAY_DAEMON_ENV]: id };
        const child = spawn(command, args, { detached: true, stdio: ["ignore", out, out], env });
        // The child dup'd the fd; close our copy so nothing leaks a descriptor.
        closeSync(out);
        // Detach the process itself: a gateway must not share the spawner's
        // stdin or take terminal signals meant for it.
        child.unref();
        return "spawned";
    } catch {
        return "error";
    }
}

/**
 * Run a gateway in the foreground (the daemon body). Claims the pidfile, starts
 * the gateway, and blocks until SIGTERM/SIGINT. Throws synchronously if the
 * gateway is unknown or another process already owns it.
 */
export async function runGatewayForeground(id: string, opts: GatewayStartOpts = {}): Promise<void> {
    const gw = getGateway(id);
    if (!gw) throw new Error(`unknown gateway: ${id}`);
    // "daemon", not "in-process": this process exists only to run the gateway,
    // so `loop gateways stop` may signal it freely.
    claimGatewayPid(id, "daemon"); // throws if another owner is live

    let handle;
    try {
        handle = await gw.start(opts);
    } catch (err) {
        clearOwnGatewayPid(id);
        throw err;
    }

    let stopping = false;
    const shutdown = () => {
        if (stopping) return; // SIGINT then SIGTERM
        stopping = true;
        handle.stop();
        clearOwnGatewayPid(id);
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    // SIGHUP: closing the terminal that ran `loop gateways <id>` in the
    // foreground takes the poller with it, instead of orphaning a bridge that
    // keeps running shell commands from a chat nobody is watching.
    process.on("SIGHUP", shutdown);
    // Best-effort cleanup on any other exit path. Ownership-checked so a
    // replacement daemon's pidfile is never removed by our exit.
    process.on("exit", () => clearOwnGatewayPid(id));

    // Block forever; the gateway polls in the background until signalled.
    await new Promise<never>(() => {});
}
