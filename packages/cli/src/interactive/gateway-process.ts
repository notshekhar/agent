/**
 * TUI-side gateway process control. Gateways never run inside the TUI — this
 * only spawns/among/checks their separate daemon processes. Opening loop brings
 * up the daemons for enabled gateways (if not already running); quitting loop
 * deliberately leaves them running — they are independent.
 */
import chalk from "chalk";
import { listEnabledGateways } from "@notshekhar/loop-core";
import { spawnGatewayDaemon } from "../gateway-daemon";
import type { AppDeps } from "./deps";

/** Spawn daemons for all enabled gateways that aren't already up. Fire-and-
 * forget at launch; a spawn failure is surfaced but never blocks startup. */
export function startEnabledGateways(deps: AppDeps): void {
    for (const gw of listEnabledGateways()) {
        const result = spawnGatewayDaemon(gw.id);
        if (result === "spawned") {
            deps.history.addSystem(
                chalk.dim(`${gw.id}: daemon started (separate process — runs independently of loop)`),
            );
        } else if (result === "error") {
            deps.history.addSystem(
                chalk.dim(`${gw.id}: could not start daemon — run \`loop gateways ${gw.id}\` to see why`),
            );
        }
    }
    deps.tui.requestRender();
}
