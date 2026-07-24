/**
 * Spawning and running gateway daemons. Every gateway runs as its own detached
 * OS process — never inside the TUI — so a phone bridge keeps polling after the
 * terminal closes, and no gateway can stall the UI's event loop.
 *
 * - spawnGatewayDaemon: fork `loop gateways <id>` detached, with a pidfile
 *   guard (never two pollers) and a logfile for its output.
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
/** The pid a spawned daemon outlives nothing beyond — see the watchdog below. */
export const GATEWAY_PARENT_ENV = "LOOP_GATEWAY_PARENT_PID";
/** How often a daemon checks that whoever spawned it is still alive. */
const PARENT_WATCH_MS = 5_000;

/** How to re-invoke this same loop with extra args. A compiled binary runs
 * itself with the args; under `bun <entry>` the entry script must lead.
 *
 * Decided from the executable, never from the entry path: inside a compiled Bun
 * binary the entry is the virtual "/$bunfs/root/cli.js", which any `.js` test
 * reads as "running from source". The daemon then got spawned as
 * `loop /$bunfs/root/cli.js gateways telegram`, whose command word is the bunfs
 * path — no such command, so it fell through to the interactive TUI, which
 * spawns daemons for enabled gateways on startup… which fell through to a TUI,
 * one new process every ~1.5s until the machine filled up. Pure so the shape of
 * that spawn is pinned by a test; goals/daemon.ts does the same check. */
export function daemonInvocation(exe: string, entry: string, extra: string[]): { command: string; args: string[] } {
    const underBun = basename(exe).toLowerCase().startsWith("bun");
    return { command: exe, args: underBun ? [entry, ...extra] : extra };
}

function selfInvocation(extra: string[]): { command: string; args: string[] } {
    return daemonInvocation(process.execPath, Bun.main ?? process.argv[1] ?? "", extra);
}

export type SpawnResult = "spawned" | "already-running" | "error" | "refused-nested";

export interface SpawnGatewayOpts {
    /** Bind the daemon's lifetime to this pid — it exits when that process
     * does. The TUI passes its own pid, so quitting loop takes its gateways
     * with it. Omitted by `loop gateways` (spawn-and-exit): that command has no
     * process left to outlive, so a watchdog would kill the daemon seconds
     * after starting it. Such a daemon runs until `loop gateways stop`. */
    ownerPid?: number;
}

/** Fork the gateway's daemon as a detached, separate process. No-op if one is
 * already live (the pidfile guard). Output goes to the gateway's logfile.
 *
 * The nested check is the load-bearing one. Getting the invocation wrong made a
 * "daemon" land in the interactive TUI, and a TUI spawns daemons on startup —
 * 212 processes before anyone noticed. selfInvocation is correct now, but this
 * is what makes the chain structurally impossible rather than merely fixed: a
 * process running as a gateway daemon cannot spawn a gateway daemon, so any
 * such recursion terminates at depth one no matter what else breaks. Enforced
 * here, at the single choke point, so no call site can forget it. */
export function spawnGatewayDaemon(id: string, opts: SpawnGatewayOpts = {}): SpawnResult {
    if (process.env[GATEWAY_DAEMON_ENV]) return "refused-nested";
    if (isGatewayRunning(id)) return "already-running";
    try {
        const { command, args } = selfInvocation(["gateways", id]);
        const out = openSync(gatewayLogPath(id), "a");
        const env: NodeJS.ProcessEnv = { ...process.env, [GATEWAY_DAEMON_ENV]: id };
        if (opts.ownerPid) env[GATEWAY_PARENT_ENV] = String(opts.ownerPid);
        const child = spawn(command, args, { detached: true, stdio: ["ignore", out, out], env });
        // The child dup'd the fd; close the parent's copy so a long-lived TUI
        // doesn't leak one descriptor per spawn.
        closeSync(out);
        // Detach the process itself: a gateway must not share the TUI's stdin
        // or take terminal signals meant for it. Its lifetime is governed by
        // ownerPid above, not by the process tree.
        child.unref();
        return "spawned";
    } catch {
        return "error";
    }
}

/**
 * Run a gateway in the foreground (the daemon body). Claims the pidfile,
 * starts the gateway, and blocks until SIGTERM/SIGINT. Throws synchronously if
 * the gateway is unknown or a daemon already owns the pidfile.
 */
export async function runGatewayForeground(id: string, opts: GatewayStartOpts = {}): Promise<void> {
    const gw = getGateway(id);
    if (!gw) throw new Error(`unknown gateway: ${id}`);
    claimGatewayPid(id); // throws if another daemon is live

    let handle;
    try {
        handle = await gw.start(opts);
    } catch (err) {
        clearOwnGatewayPid(id);
        throw err;
    }

    let watchdog: ReturnType<typeof setInterval> | undefined;
    let stopping = false;
    const shutdown = () => {
        if (stopping) return; // SIGINT then SIGTERM, or a signal racing the watchdog
        stopping = true;
        if (watchdog) clearInterval(watchdog);
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

    // Backstop for the spawned case: signals never arrive if the loop that
    // spawned us was SIGKILLed or crashed, so poll that it still exists. Being
    // detached is what makes this necessary — we're in our own session, so the
    // parent's death reaches us no other way.
    const parentPid = Number(process.env[GATEWAY_PARENT_ENV]);
    if (Number.isInteger(parentPid) && parentPid > 1) {
        watchdog = setInterval(() => {
            try {
                process.kill(parentPid, 0); // existence check only
            } catch {
                shutdown();
            }
        }, PARENT_WATCH_MS);
    }
    // Best-effort cleanup on any other exit path. Ownership-checked so a
    // replacement daemon's pidfile is never removed by our exit.
    process.on("exit", () => clearOwnGatewayPid(id));

    // Block forever; the gateway polls in the background until signalled.
    await new Promise<never>(() => {});
}
