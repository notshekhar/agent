/**
 * Minimal Telegram Bot API client — plain fetch against api.telegram.org, no
 * SDK dependency. Long polling (getUpdates) is the transport: it works from
 * any machine behind NAT, no webhook or public URL required. Telegram also
 * enforces a single getUpdates consumer per token (a second poller gets 409),
 * which doubles as a free "only one bridge" lock.
 */

export interface TgUser {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
}

export interface TgChat {
    id: number;
    type: string;
    username?: string;
    first_name?: string;
}

export interface TgPhotoSize {
    file_id: string;
    width: number;
    height: number;
    file_size?: number;
}

export interface TgMessage {
    message_id: number;
    chat: TgChat;
    from?: TgUser;
    text?: string;
    caption?: string;
    /** Telegram sends several sizes per photo, smallest first. */
    photo?: TgPhotoSize[];
}

export interface TgCallbackQuery {
    id: string;
    from: TgUser;
    message?: TgMessage;
    data?: string;
}

export interface TgUpdate {
    update_id: number;
    message?: TgMessage;
    callback_query?: TgCallbackQuery;
}

export interface InlineButton {
    text: string;
    callback_data?: string;
    url?: string;
}

/** Rows of buttons, exactly Telegram's reply_markup.inline_keyboard shape. */
export type InlineKeyboard = InlineButton[][];

export interface BotCommandDef {
    command: string;
    description: string;
}

interface TgEnvelope<T> {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
    constructor(
        message: string,
        readonly code?: number,
    ) {
        super(message);
        this.name = "TelegramApiError";
    }
}

/** True for the parse errors bad HTML output produces — the caller's cue to
 * resend the same text without parse_mode instead of dropping the message. */
export function isParseError(err: unknown): boolean {
    return err instanceof TelegramApiError && /parse entities/i.test(err.message);
}

/** "message is not modified" — harmless outcome of a throttled edit landing
 * after the content stopped changing; callers treat it as success. */
export function isNotModifiedError(err: unknown): boolean {
    return err instanceof TelegramApiError && /not modified/i.test(err.message);
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Telegram's hard message length limit (UTF-16 code units). */
export const TG_MESSAGE_LIMIT = 4096;

export class TelegramApi {
    constructor(
        private readonly token: string,
        private readonly fetchFn: FetchLike = fetch,
    ) {}

    private async request<T>(
        method: string,
        body: string | FormData,
        contentType?: string,
        timeoutMs?: number,
    ): Promise<T> {
        // Retry loop for 429s only — Telegram tells us exactly how long to
        // back off (parameters.retry_after). Everything else throws.
        for (;;) {
            const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
                method: "POST",
                headers: contentType ? { "content-type": contentType } : undefined,
                body,
                // Guard against a black-holed connection: without this a hung
                // long-poll fetch never resolves and the daemon stops polling.
                // On abort the caller's poll loop catches, backs off, and retries.
                signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
            });
            const env = (await res.json()) as TgEnvelope<T>;
            if (env.ok) return env.result as T;
            const retryAfter = env.parameters?.retry_after;
            if (env.error_code === 429 && typeof retryAfter === "number") {
                await sleep((retryAfter + 0.5) * 1000);
                continue;
            }
            throw new TelegramApiError(env.description ?? `${method} failed`, env.error_code);
        }
    }

    private call<T>(method: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
        return this.request<T>(method, JSON.stringify(payload), "application/json", timeoutMs);
    }

    getMe(): Promise<TgUser> {
        return this.call<TgUser>("getMe");
    }

    /** Long poll for updates. Only message + callback_query are requested —
     * fewer wakeups, and exactly what the bridge handles. */
    getUpdates(opts: { offset?: number; timeoutSec?: number } = {}): Promise<TgUpdate[]> {
        const timeoutSec = opts.timeoutSec ?? 50;
        return this.call<TgUpdate[]>(
            "getUpdates",
            {
                offset: opts.offset,
                timeout: timeoutSec,
                allowed_updates: ["message", "callback_query"],
            },
            // Client timeout a comfortable margin past the server's long-poll
            // window; a healthy poll returns at/under timeoutSec.
            (timeoutSec + 15) * 1000,
        );
    }

    sendMessage(opts: { chatId: number; text: string; html?: boolean; keyboard?: InlineKeyboard }): Promise<TgMessage> {
        return this.call<TgMessage>("sendMessage", {
            chat_id: opts.chatId,
            text: opts.text,
            parse_mode: opts.html ? "HTML" : undefined,
            reply_markup: opts.keyboard ? { inline_keyboard: opts.keyboard } : undefined,
            link_preview_options: { is_disabled: true },
        });
    }

    editMessageText(opts: {
        chatId: number;
        messageId: number;
        text: string;
        html?: boolean;
        keyboard?: InlineKeyboard;
    }): Promise<void> {
        return this.call("editMessageText", {
            chat_id: opts.chatId,
            message_id: opts.messageId,
            text: opts.text,
            parse_mode: opts.html ? "HTML" : undefined,
            reply_markup: opts.keyboard ? { inline_keyboard: opts.keyboard } : undefined,
            link_preview_options: { is_disabled: true },
        });
    }

    /** Ack a button tap (stops the client-side spinner); text is optional toast. */
    answerCallbackQuery(id: string, text?: string): Promise<void> {
        return this.call("answerCallbackQuery", { callback_query_id: id, text });
    }

    setMyCommands(commands: BotCommandDef[]): Promise<void> {
        return this.call("setMyCommands", { commands });
    }

    /** "typing" indicator while a turn runs; Telegram auto-clears it in ~5s. */
    sendChatAction(chatId: number, action = "typing"): Promise<void> {
        return this.call("sendChatAction", { chat_id: chatId, action });
    }

    sendDocument(opts: { chatId: number; filename: string; content: string; caption?: string }): Promise<void> {
        const form = new FormData();
        form.set("chat_id", String(opts.chatId));
        if (opts.caption) form.set("caption", opts.caption);
        form.set("document", new Blob([opts.content]), opts.filename);
        return this.request("sendDocument", form);
    }

    /** Download a file (e.g. a sent photo) as base64 for session.send images. */
    async getFileBase64(fileId: string): Promise<{ data: string; size: number }> {
        const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
        if (!file.file_path) throw new TelegramApiError("getFile returned no file_path");
        const res = await this.fetchFn(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
        if (!res.ok) throw new TelegramApiError(`file download failed: HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { data: Buffer.from(bytes).toString("base64"), size: bytes.length };
    }
}
