/**
 * Telegram setup UI, reached from /gateways → Telegram. Configures the bot
 * token, enables/disables the bridge, shows the pairing deep link, and
 * starts/stops the bridge — which runs IN THIS PROCESS, so enabling starts it
 * here and disabling stops it here. Because start() is awaited rather than
 * spawned, a bad token surfaces as an error on this screen instead of only in
 * a logfile.
 */
import chalk from "chalk";
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    TelegramApi,
    clearTelegram,
    getGateway,
    getTelegramConfig,
    isGatewayRunning,
    liveGatewayOwner,
    resetTelegramPairing,
    setTelegramEnabled,
    storeTelegramSetup,
    telegramPairLink,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { isGatewayRunningHere, startGatewayHere, stopGatewayHere } from "../gateway-process";
import type { GatewayUi } from "./types";

const ID = "telegram";

/** Start the bridge here, reporting the outcome. Awaiting the real start is
 * the whole point of running in-process: "running" means the token validated
 * and the poll loop is up, not "a child was forked and might be fine". */
async function startHere(state: AppState, deps: AppDeps): Promise<void> {
    if (isGatewayRunningHere(ID)) return;
    const gw = getGateway(ID);
    if (!gw) return;
    deps.showWorking("Starting telegram bridge");
    deps.tui.requestRender();
    let result: Awaited<ReturnType<typeof startGatewayHere>>;
    try {
        result = await startGatewayHere(gw, state, deps);
    } finally {
        deps.hideWorking();
    }
    if (result === "started") {
        deps.history.addSystem(chalk.dim("telegram: bridge running in this loop"));
    } else if (result === "already-running") {
        const owner = liveGatewayOwner(ID);
        deps.history.addSystem(
            chalk.dim(
                `telegram: already served by pid ${owner?.pid ?? "?"} — only one poller per bot token is allowed`,
            ),
        );
    }
    // "error" already reported the reason (bad token, network) via startGatewayHere.
    deps.tui.requestRender();
}

/** Stop the bridge if this loop is the one serving it. A gateway owned by
 * another process is left alone — it isn't ours to stop. */
function stopHere(deps: AppDeps): void {
    if (stopGatewayHere(ID)) {
        deps.history.addSystem(chalk.dim("telegram: bridge stopped"));
        deps.tui.requestRender();
    }
}

/** Make the live bridge match the enabled flag. */
async function syncBridge(state: AppState, deps: AppDeps): Promise<void> {
    if (getTelegramConfig().enabled) await startHere(state, deps);
    else stopHere(deps);
}

async function run(state: AppState, deps: AppDeps): Promise<void> {
    const { history, tui, searchOnce, promptOnce, showWorking, hideWorking } = deps;

    while (true) {
        const cfg = getTelegramConfig();
        const running = isGatewayRunning(ID);
        // Running somewhere else (another loop, a `loop gateways` daemon) is a
        // different state from running here: only the latter is ours to stop.
        const elsewhere = running && !isGatewayRunningHere(ID);
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
                label: `bridge: ${cfg.enabled ? "on" : "off"}${cfg.enabled ? (elsewhere ? " · running elsewhere" : running ? " · running here" : " · not running") : ""}`,
                description: cfg.enabled
                    ? "turn the Telegram bridge off (stops it in this loop)"
                    : "enable and start the Telegram bridge in this loop",
            });
            if (cfg.enabled) {
                items.push({
                    value: "restart",
                    label: "restart bridge",
                    description: "stop and re-start the bridge in this loop",
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
                { value: "set-token", label: "replace token", description: "swap in a different bot (re-pairs)" },
                { value: "disconnect", label: "disconnect", description: "remove the token and stop the bridge" },
            );
        }

        const status = !cfg.token
            ? "not configured"
            : elsewhere
              ? `running in pid ${liveGatewayOwner(ID)?.pid}`
              : running
                ? "running"
                : cfg.enabled
                  ? "not running"
                  : "stopped";
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
            // Replacing a token: stop the old bridge before the new one starts.
            stopHere(deps);
            const pairCode = storeTelegramSetup({ token, botUsername: username });
            setTelegramEnabled(true);
            await startHere(state, deps);
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
            await syncBridge(state, deps);
            tui.requestRender();
            continue;
        }

        if (pick.value === "restart") {
            stopHere(deps);
            await startHere(state, deps);
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
            // The running bridge caches the old (now-cleared) pairing; restart
            // it so it picks up the fresh code.
            stopHere(deps);
            await syncBridge(state, deps);
            history.addSystem(
                chalk.dim(
                    `telegram: re-pair on your phone and press Start:\n  ${telegramPairLink(cfg.botUsername, pairCode)}`,
                ),
            );
            tui.requestRender();
            continue;
        }

        if (pick.value === "disconnect") {
            stopHere(deps);
            clearTelegram();
            history.addSystem("telegram: disconnected (bridge stopped, token removed)");
            tui.requestRender();
            continue;
        }
    }
}

export const telegramGatewayUi: GatewayUi = { id: ID, run };
