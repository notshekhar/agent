/**
 * Telegram setup UI, reached from /gateways → Telegram. Configures the bot
 * token, enables/disables the bridge, shows the pairing deep link, and
 * starts/stops the Telegram daemon — a SEPARATE process (never in the TUI), so
 * enabling spawns it and disabling terminates it.
 */
import chalk from "chalk";
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    TelegramApi,
    clearTelegram,
    gatewayLogPath,
    getTelegramConfig,
    isGatewayRunning,
    resetTelegramPairing,
    setTelegramEnabled,
    stopGatewayDaemon,
    storeTelegramSetup,
    telegramPairLink,
    PRODUCT_NAME,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { spawnGatewayDaemon } from "../../gateway-daemon";
import type { GatewayUi } from "./types";

const ID = "telegram";

/** The daemon is a detached process — spawning it forks a child that must
 * boot, validate the token over the network, and claim its pidfile before it
 * reads as "running". Poll until a state settles (or we give up) so the menu
 * repaints with the real state instead of a stale "starting…". */
async function waitForState(want: boolean, deps: AppDeps, working: string, timeoutMs = 8000): Promise<void> {
    if (isGatewayRunning(ID) === want) return;
    deps.showWorking(working);
    deps.tui.requestRender();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 200));
        if (isGatewayRunning(ID) === want) break;
    }
    deps.hideWorking();
    deps.tui.requestRender();
}

/** Ensure the daemon reflects the enabled flag: spawn when on, stop when off —
 * and wait for that to actually take effect before returning. */
async function syncDaemon(deps: AppDeps): Promise<void> {
    const cfg = getTelegramConfig();
    if (cfg.enabled) {
        spawnGatewayDaemon(ID);
        await waitForState(true, deps, "Starting telegram daemon");
        if (isGatewayRunning(ID)) {
            deps.history.addSystem(chalk.dim("telegram: daemon running (separate process)"));
        } else {
            deps.history.addSystem(
                chalk.dim(`telegram: daemon did not come up — check the log: ${gatewayLogPath(ID)}`),
            );
        }
    } else {
        stopGatewayDaemon(ID);
        await waitForState(false, deps, "Stopping telegram daemon", 3000);
    }
}

async function run(state: AppState, deps: AppDeps): Promise<void> {
    const { history, tui, searchOnce, promptOnce, showWorking, hideWorking } = deps;

    while (true) {
        const cfg = getTelegramConfig();
        const running = isGatewayRunning(ID);
        const items: SelectItem[] = [];

        if (!cfg.token) {
            items.push({
                value: "set-token",
                label: "connect a bot",
                description: "paste the token from @BotFather to set up the bridge",
            });
        } else {
            items.push({
                value: "toggle",
                label: `bridge: ${cfg.enabled ? "on" : "off"}${cfg.enabled ? (running ? " · running" : " · not running") : ""}`,
                description: cfg.enabled
                    ? "turn the Telegram bridge off (stops its daemon)"
                    : "enable and start the Telegram daemon (separate process)",
            });
            if (cfg.enabled) {
                items.push({
                    value: "restart",
                    label: "restart daemon",
                    description: "stop and re-spawn the daemon process",
                });
            }
            if (cfg.botUsername && cfg.pairCode && !cfg.chatId) {
                items.push({
                    value: "pair-link",
                    label: "show pairing link",
                    description: "open it on your phone and send /start to claim the bot",
                });
            }
            if (cfg.chatId) {
                items.push({
                    value: "repair",
                    label: "re-pair (new device)",
                    description: "drop the current phone and issue a fresh pairing code",
                });
            }
            items.push(
                { value: "log", label: "daemon log path", description: "where the daemon writes its output" },
                { value: "set-token", label: "replace token", description: "swap in a different bot (re-pairs)" },
                { value: "disconnect", label: "disconnect", description: "remove the token and stop the daemon" },
            );
        }

        const status = cfg.token ? (running ? "running" : cfg.enabled ? "not running" : "stopped") : "not configured";
        const pick = await searchOnce(items, `Telegram — ${status} (Esc to close)`);
        if (!pick) return;

        if (pick.value === "set-token") {
            history.addSystem("paste the bot token from @BotFather (Esc to cancel):");
            tui.requestRender();
            const token = (await promptOnce("")).trim();
            if (!token) continue;
            showWorking("Validating token");
            tui.requestRender();
            let username: string;
            try {
                const me = await new TelegramApi(token).getMe();
                username = me.username ?? "";
            } catch (err) {
                hideWorking();
                history.addError(`telegram: token rejected — ${(err as Error).message}`);
                tui.requestRender();
                continue;
            } finally {
                hideWorking();
            }
            // Replacing a token: stop the old daemon before the new one starts.
            stopGatewayDaemon(ID);
            await waitForState(false, deps, "Stopping old daemon", 3000);
            const pairCode = storeTelegramSetup({ token, botUsername: username });
            setTelegramEnabled(true);
            await syncDaemon(deps);
            history.addSystem(
                chalk.dim(
                    `telegram: connected to @${username}. Open this link on your phone and press Start:\n  ` +
                        telegramPairLink(username, pairCode),
                ),
            );
            tui.requestRender();
            continue;
        }

        if (pick.value === "toggle") {
            const next = !cfg.enabled;
            setTelegramEnabled(next);
            history.addSystem(`telegram bridge → ${next ? "on" : "off"}`);
            await syncDaemon(deps);
            tui.requestRender();
            continue;
        }

        if (pick.value === "restart") {
            stopGatewayDaemon(ID);
            await waitForState(false, deps, "Stopping telegram daemon", 3000);
            spawnGatewayDaemon(ID);
            await waitForState(true, deps, "Restarting telegram daemon");
            history.addSystem(
                chalk.dim(
                    isGatewayRunning(ID) ? "telegram: daemon restarted" : "telegram: restart failed — check the log",
                ),
            );
            tui.requestRender();
            continue;
        }

        if (pick.value === "pair-link" && cfg.botUsername && cfg.pairCode) {
            history.addSystem(
                chalk.dim(
                    `telegram: open on your phone and press Start:\n  ${telegramPairLink(cfg.botUsername, cfg.pairCode)}`,
                ),
            );
            tui.requestRender();
            continue;
        }

        if (pick.value === "repair" && cfg.botUsername) {
            const pairCode = resetTelegramPairing();
            // The running daemon caches the old (now-cleared) pairing; restart
            // it so it picks up the fresh code.
            stopGatewayDaemon(ID);
            await waitForState(false, deps, "Stopping telegram daemon", 3000);
            await syncDaemon(deps);
            history.addSystem(
                chalk.dim(
                    `telegram: re-pair on your phone and press Start:\n  ${telegramPairLink(cfg.botUsername, pairCode)}`,
                ),
            );
            tui.requestRender();
            continue;
        }

        if (pick.value === "log") {
            history.addSystem(chalk.dim(`telegram: daemon log → ${gatewayLogPath(ID)}`));
            tui.requestRender();
            continue;
        }

        if (pick.value === "disconnect") {
            stopGatewayDaemon(ID);
            await waitForState(false, deps, "Stopping telegram daemon", 3000);
            clearTelegram();
            history.addSystem("telegram: disconnected (daemon stopped, token removed)");
            tui.requestRender();
            continue;
        }
    }
}

export const telegramGatewayUi: GatewayUi = { id: ID, run };
