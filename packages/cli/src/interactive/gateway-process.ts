/**
 * TUI-side gateway process control. Gateways never run inside the TUI — this
 * only spawns/stops/checks their separate daemon processes. Opening loop brings
 * up the daemons for enabled gateways (if not already running); quitting loop
 * stops the ones it started, so a phone bridge never outlives the loop that
 * owns it. Daemons someone else started (another loop, a foreground
 * `loop gateways <id>`) follow their own starter and are left alone.
 */
import chalk from "chalk";
import { listEnabledGateways, stopGatewayDaemon } from "@notshekhar/loop-core";
import { spawnGatewayDaemon } from "../gateway-daemon";
import type { AppDeps } from "./deps";

/** Gateway ids whose daemon this process spawned — the ones we stop on exit. */
const spawnedHere = new Set<string>();

/** Spawn daemons for all enabled gateways that aren't already up. Fire-and-
 * forget at launch; a spawn failure is surfaced but never blocks startup. */
export function startEnabledGateways(deps: AppDeps): void {
    for (const gw of listEnabledGateways()) {
        // "refused-nested" (this process is itself a gateway daemon) is
        // deliberately silent — spawnGatewayDaemon enforces it, and it means a
        // recursion was just stopped, not that the user did anything wrong.
        const result = spawnGatewayDaemon(gw.id, { ownerPid: process.pid });
        if (result === "spawned") {
            spawnedHere.add(gw.id);
            deps.history.addSystem(chalk.dim(`${gw.id}: daemon started (separate process, stops when loop exits)`));
        } else if (result === "error") {
            deps.history.addSystem(
                chalk.dim(`${gw.id}: could not start daemon — run \`loop gateways ${gw.id}\` to see why`),
            );
        }
    }
    deps.tui.requestRender();
}

/** Stop the daemons this loop started. Best-effort and synchronous-ish: it
 * only signals, and the daemon's own parent watchdog catches whatever a missed
 * signal leaves behind. */
export function stopSpawnedGateways(): void {
    for (const id of spawnedHere) {
        try {
            stopGatewayDaemon(id);
        } catch {
            // Never let a dying gateway hold up the TUI's exit path.
        }
    }
    spawnedHere.clear();
}
