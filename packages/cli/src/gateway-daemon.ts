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
import {
    claimGatewayPid,
    clearOwnGatewayPid,
    gatewayLogPath,
    getGateway,
    isGatewayRunning,
    type GatewayStartOpts,
} from "@notshekhar/loop-core";

/** How to re-invoke this same loop with extra args. A compiled binary runs
 * itself with the args; from source (bun cli.ts) the script path leads. */
function selfInvocation(extra: string[]): { command: string; args: string[] } {
    const script = process.argv[1];
    const fromSource = typeof script === "string" && /\.(ts|js|mjs|cjs)$/.test(script);
    return fromSource
        ? { command: process.execPath, args: [script, ...extra] }
        : { command: process.execPath, args: extra };
}

export type SpawnResult = "spawned" | "already-running" | "error";

/** Fork the gateway's daemon as a detached, independent process. No-op if one
 * is already live (the pidfile guard). Output goes to the gateway's logfile. */
export function spawnGatewayDaemon(id: string): SpawnResult {
    if (isGatewayRunning(id)) return "already-running";
    try {
        const { command, args } = selfInvocation(["gateways", id]);
        const out = openSync(gatewayLogPath(id), "a");
        const child = spawn(command, args, { detached: true, stdio: ["ignore", out, out] });
        // The child dup'd the fd; close the parent's copy so a long-lived TUI
        // doesn't leak one descriptor per spawn.
        closeSync(out);
        // Fully detach: the daemon outlives this process (the TUI or the CLI
        // that spawned it), which is the whole point of a separate daemon.
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

    const shutdown = () => {
        handle.stop();
        clearOwnGatewayPid(id);
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    // Best-effort cleanup on any other exit path. Ownership-checked so a
    // replacement daemon's pidfile is never removed by our exit.
    process.on("exit", () => clearOwnGatewayPid(id));

    // Block forever; the gateway polls in the background until signalled.
    await new Promise<never>(() => {});
}
