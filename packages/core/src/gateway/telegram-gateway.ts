/**
 * Telegram as a Gateway: adapts the existing telegram module (store + bridge)
 * to the uniform Gateway lifecycle. All Telegram-specific knowledge (pairing,
 * bot username, deep links) stays behind this adapter — the framework only
 * sees the generic surface.
 */
import {
    clearTelegram,
    getTelegramConfig,
    isTelegramConfigured,
    isTelegramEnabled,
    setTelegramEnabled,
    startTelegramBridge,
} from "../telegram";
import type { Gateway, GatewayHandle, GatewayStartOpts, GatewayStatus } from "./types";

export const telegramGateway: Gateway = {
    id: "telegram",
    displayName: "Telegram",

    isConfigured: () => isTelegramConfigured(),
    isEnabled: () => isTelegramEnabled(),
    setEnabled: (enabled) => setTelegramEnabled(enabled),
    disconnect: () => clearTelegram(),

    status(): GatewayStatus {
        const cfg = getTelegramConfig();
        const at = cfg.botUsername ? `@${cfg.botUsername}` : "bot";
        const summary = !cfg.token
            ? "not configured"
            : !cfg.enabled
              ? `${at} · off`
              : !cfg.chatId
                ? `${at} · waiting to pair`
                : `${at} · connected`;
        const detail: string[] = [];
        if (cfg.token) {
            detail.push(`bot       ${cfg.botUsername ? `@${cfg.botUsername}` : "(unknown)"}`);
            detail.push(`enabled   ${cfg.enabled ? "yes" : "no"}`);
            detail.push(`paired    ${cfg.chatId ? `chat ${cfg.chatId}` : "no — send /start on your phone"}`);
        }
        return { configured: !!cfg.token, enabled: cfg.enabled, summary, detail };
    },

    async start(opts: GatewayStartOpts): Promise<GatewayHandle> {
        const handle = await startTelegramBridge({ cwd: opts.cwd, log: opts.log });
        // Post-start hint lives here (gateway-specific): the framework can't
        // know Telegram needs a /start to pair.
        if (!getTelegramConfig().chatId) {
            opts.log?.(`polling as @${handle.botUsername} — send /start on your phone to pair`);
        }
        return { stop: () => handle.stop() };
    },
};
