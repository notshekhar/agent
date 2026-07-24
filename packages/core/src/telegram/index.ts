/**
 * Telegram bridge orchestration: wire a TelegramApi + an in-process RpcServer
 * into a TelegramBridge, and run it. One entry point shared by the TUI
 * (auto-start when enabled) and the headless `loop telegram` daemon.
 */
import { RpcServer } from "../rpc/server";
import { TelegramApi, TelegramApiError } from "./api";
import { TelegramBridge, BOT_COMMANDS } from "./bridge";
import { getTelegramConfig, storeTelegramChatId } from "./store";

export { TelegramApi, TelegramApiError, isParseError, isNotModifiedError, TG_MESSAGE_LIMIT } from "./api";
export type { TgUpdate, TgMessage, TgUser, InlineKeyboard, BotCommandDef } from "./api";
export { TelegramBridge, BOT_COMMANDS } from "./bridge";
export {
    getTelegramConfig,
    isTelegramConfigured,
    isTelegramEnabled,
    storeTelegramSetup,
    storeTelegramChatId,
    resetTelegramPairing,
    setTelegramEnabled,
    clearTelegram,
    telegramPairLink,
    type TelegramConfig,
} from "./store";
export { markdownToTelegramChunks, formatCost, formatContext, formatSteak, toolLine, CHUNK_LIMIT } from "./render";

export interface TelegramBridgeHandle {
    /** Bot username validated at startup — for the pairing link. */
    botUsername: string;
    stop(): void;
}

/** Validate the stored token, start the bridge on its own RpcServer, and keep
 * polling until stop(). Rejects if telegram isn't configured or the token is
 * bad. `onPaired` persists the claimed chat id by default. */
export async function startTelegramBridge(
    opts: {
        cwd?: string;
        log?: (line: string) => void;
        onPaired?: (chatId: number) => void;
    } = {},
): Promise<TelegramBridgeHandle> {
    const cfg = getTelegramConfig();
    if (!cfg.token) throw new TelegramApiError("no telegram token configured");

    const api = new TelegramApi(cfg.token);
    const rpc = new RpcServer();
    const bridge = new TelegramBridge({
        api,
        rpc,
        chatId: cfg.chatId,
        pairCode: cfg.pairCode,
        cwd: opts.cwd,
        log: opts.log,
        onPaired: (chatId) => {
            storeTelegramChatId(chatId);
            opts.onPaired?.(chatId);
        },
    });

    // run() validates the token (getMe) before entering the poll loop, so a
    // bad token surfaces here rather than silently spinning.
    const me = await bridge.startAndValidate();
    void bridge.pollForever();
    return { botUsername: me.username ?? "", stop: () => bridge.stop() };
}

export { BOT_COMMANDS as TELEGRAM_BOT_COMMANDS };
