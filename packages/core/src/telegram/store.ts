/**
 * Persistence for the Telegram bridge: bot token, the single paired chat, the
 * one-time pairing code, and the enable flag. Lives in auth.json next to
 * provider credentials (same pattern as serve-token-store) — the bot token is
 * full remote control of this machine, so it belongs with the other secrets
 * tests never touch. Kept together (not split into settings.json) so a token
 * and its paired chat can never drift apart across files.
 */
import { randomBytes } from "node:crypto";
import { authStore } from "../auth/storage";

export interface TelegramConfig {
    token?: string;
    /** The one chat allowed to drive the bridge. Unset until /start pairing. */
    chatId?: number;
    /** One-time code required in /start <code> to claim the paired slot. */
    pairCode?: string;
    /** Bot username from getMe at setup — for printing t.me deep links. */
    botUsername?: string;
    /** Master switch. A token can stay stored while the bridge is off. */
    enabled: boolean;
}

export function getTelegramConfig(): TelegramConfig {
    const token = authStore.get("telegramToken");
    const chatId = authStore.get("telegramChatId");
    const pairCode = authStore.get("telegramPairCode");
    const botUsername = authStore.get("telegramBotUsername");
    return {
        token: typeof token === "string" && token.length > 0 ? token : undefined,
        chatId: typeof chatId === "number" ? chatId : undefined,
        pairCode: typeof pairCode === "string" && pairCode.length > 0 ? pairCode : undefined,
        botUsername: typeof botUsername === "string" && botUsername.length > 0 ? botUsername : undefined,
        enabled: authStore.get("telegramEnabled") === true,
    };
}

/** True once a token exists — the bridge can be enabled. */
export function isTelegramConfigured(): boolean {
    return getTelegramConfig().token !== undefined;
}

export function isTelegramEnabled(): boolean {
    const cfg = getTelegramConfig();
    return cfg.enabled && cfg.token !== undefined;
}

/** New token setup: stores token + bot username, mints a fresh pair code, and
 * DROPS any existing pairing — a re-setup must re-pair, or a stale chat keeps
 * control. Returns the new pair code for the t.me deep link. */
export function storeTelegramSetup(cfg: { token: string; botUsername: string }): string {
    const pairCode = randomBytes(4).toString("hex");
    authStore.set("telegramToken", cfg.token);
    authStore.set("telegramBotUsername", cfg.botUsername);
    authStore.set("telegramPairCode", pairCode);
    authStore.delete("telegramChatId");
    return pairCode;
}

/** Drop the current pairing and issue a new code (re-pair a different phone). */
export function resetTelegramPairing(): string {
    const pairCode = randomBytes(4).toString("hex");
    authStore.set("telegramPairCode", pairCode);
    authStore.delete("telegramChatId");
    return pairCode;
}

export function setTelegramEnabled(enabled: boolean): void {
    authStore.set("telegramEnabled", enabled);
}

/** Pairing succeeded: lock the bridge to this chat and burn the code. */
export function storeTelegramChatId(chatId: number): void {
    authStore.set("telegramChatId", chatId);
    authStore.delete("telegramPairCode");
}

export function clearTelegram(): void {
    authStore.delete("telegramToken");
    authStore.delete("telegramChatId");
    authStore.delete("telegramPairCode");
    authStore.delete("telegramBotUsername");
    authStore.delete("telegramEnabled");
}

/** t.me deep link that opens the bot and pre-fills /start <code>. */
export function telegramPairLink(botUsername: string, pairCode: string): string {
    return `https://t.me/${botUsername}?start=${pairCode}`;
}
