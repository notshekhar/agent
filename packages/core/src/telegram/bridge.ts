/**
 * The Telegram bridge: a full remote client for the agent, speaking the same
 * JSON-RPC surface as the web UI — attached in-process to an RpcServer, so
 * sessions, turn events, replay, settings and cost all come from the one
 * implementation.
 *
 * Transport is getUpdates long polling (no webhook, works behind NAT), and
 * Telegram allows exactly one poller per token, which doubles as a single-
 * bridge lock. Security model: the bridge answers ONE paired chat, claimed
 * with the one-time /start <code> from setup — everyone else is refused.
 * Possession of the paired chat is full control of this machine.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { PRODUCT_NAME } from "../brand";
import { INIT_PROMPT } from "../commands";
import { THINKING_LEVELS, type ThinkingLevel } from "../agent/thinking";
import type { ContextReport } from "../agent/context-report";
import type { SteakGrid } from "../agent/steak";
import type { CostStats } from "../agent/cost";
import type { CostBreakdown } from "../types";
import type { RpcNotification, RpcRequest, RpcResponse } from "../rpc/protocol";
import {
    isNotModifiedError,
    isParseError,
    type BotCommandDef,
    type InlineKeyboard,
    type TgCallbackQuery,
    type TgMessage,
    type TgUpdate,
    type TgUser,
    TelegramApiError,
} from "./api";
import {
    escapeHtml,
    formatContext,
    formatCost,
    formatSteak,
    htmlToPlain,
    markdownToTelegramChunks,
    sessionTranscriptMessages,
    streamCut,
    streamPreview,
    STREAM_SOFT_LIMIT,
    toolLine,
    toolMessageHtml,
    truncate,
} from "./render";
import {
    extensionsKeyboard,
    modelKeyboard,
    providerKeyboard,
    sessionsKeyboard,
    settingsKeyboard,
    thinkingKeyboard,
    type ModelRow,
} from "./menus";

/** The command menu Telegram shows natively (setMyCommands). Everything the
 * RPC surface can honestly do remotely — panel commands become inline-
 * keyboard menus, terminal-only commands (/ui, /hotkeys, /copy…) and
 * security-sensitive ones (/login, /install) are deliberately absent. */
export const BOT_COMMANDS: BotCommandDef[] = [
    { command: "new", description: "Start a new session" },
    { command: "sessions", description: "List sessions and switch" },
    { command: "cancel", description: "Cancel the running turn and drop the queue" },
    { command: "queue", description: "Queue a message for after this turn (no args: list, clear: empty it)" },
    { command: "model", description: "Pick provider and model" },
    { command: "thinking", description: "Set reasoning effort" },
    { command: "settings", description: "Toggle settings" },
    { command: "cost", description: "Cost breakdown" },
    { command: "context", description: "Context window usage" },
    { command: "steak", description: "Token usage heatmap" },
    { command: "session", description: "Current session info" },
    { command: "name", description: "Rename the session: /name <text>" },
    { command: "compact", description: "Compact the session context" },
    { command: "export", description: "Export session transcript file" },
    { command: "extensions", description: "Enable or disable extensions" },
    { command: "cd", description: "Set working dir for new sessions" },
    { command: "status", description: "Bridge status" },
    { command: "init", description: "Analyze the repo, write AGENTS.md" },
    { command: "help", description: "List commands" },
];

/** Aliases accepted in chat but kept out of the menu to reduce noise. */
const COMMAND_ALIASES: Record<string, string> = {
    clear: "new",
    resume: "sessions",
    rename: "name",
    stop: "cancel",
    effort: "thinking",
    cwd: "cd",
    provider: "model",
    start: "start",
    enqueue: "queue",
    queued: "queue",
};

/** Minimum surface of TelegramApi the bridge uses — tests inject a fake. */
export interface TelegramApiLike {
    getMe(): Promise<TgUser>;
    getUpdates(opts: { offset?: number; timeoutSec?: number }): Promise<TgUpdate[]>;
    sendMessage(opts: { chatId: number; text: string; html?: boolean; keyboard?: InlineKeyboard }): Promise<TgMessage>;
    editMessageText(opts: {
        chatId: number;
        messageId: number;
        text: string;
        html?: boolean;
        keyboard?: InlineKeyboard;
    }): Promise<void>;
    answerCallbackQuery(id: string, text?: string): Promise<void>;
    setMyCommands(commands: BotCommandDef[]): Promise<void>;
    sendChatAction(chatId: number, action?: string): Promise<void>;
    sendDocument(opts: { chatId: number; filename: string; content: string; caption?: string }): Promise<void>;
    getFileBase64(fileId: string): Promise<{ data: string; size: number }>;
}

/** Structurally satisfied by RpcServer — and by a fake jsonrpc peer in tests. */
export interface RpcAttachable {
    attach(transport: { send(msg: RpcResponse | RpcNotification): void }): {
        feed(chunk: string): void;
        close(): void;
    };
}

/** In-process JSON-RPC peer over RpcServer's line transport. */
class RpcPeer {
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private feed: (chunk: string) => void;
    private closeFn: () => void;
    onNotification: (method: string, params: unknown) => void = () => {};

    constructor(rpc: RpcAttachable) {
        const attached = rpc.attach({ send: (msg) => this.receive(msg) });
        this.feed = attached.feed;
        this.closeFn = attached.close;
    }

    private receive(msg: RpcResponse | RpcNotification): void {
        if ("id" in msg && msg.id !== null && msg.id !== undefined) {
            const res = msg as RpcResponse;
            const pending = this.pending.get(res.id as number);
            if (!pending) return;
            this.pending.delete(res.id as number);
            if (res.error) pending.reject(new Error(res.error.message));
            else pending.resolve(res.result);
        } else if ("method" in msg) {
            this.onNotification(msg.method, msg.params);
        }
    }

    call<T = unknown>(method: string, params?: unknown): Promise<T> {
        const id = this.nextId++;
        const req: RpcRequest = { jsonrpc: "2.0", id, method, params };
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            this.feed(JSON.stringify(req) + "\n");
        });
    }

    close(): void {
        this.closeFn();
    }
}

/** A block of assistant prose being streamed live: grown by editing the active
 * Telegram message as tokens arrive (like the TUI's live text). When the active
 * message fills up it's sealed and a new one continues the block, so a long
 * answer streams across as many messages as it needs — no truncation. */
interface TextStream {
    /** The message currently growing. */
    messageId: number;
    /** Full text of this block so far (across all its messages). */
    text: string;
    /** Chars of `text` already sealed into earlier, completed messages. */
    committedLen: number;
    /** Last preview pushed to the active message — skip identical edits. */
    sent: string;
    /** Wall-clock of the last edit; throttles edits to EDIT_INTERVAL_MS. */
    lastEditAt: number;
}

/**
 * Live rendering state of the turn in flight. The bridge streams the turn as
 * it happens: each tool call is its own message, and each block of assistant
 * prose streams token-by-token into its own message (edited live), then seals
 * to formatted markdown. Reads like a chat transcript that types itself out.
 */
interface LiveTurn {
    startedAt: number;
    /** The assistant-text message currently streaming, if any. */
    stream?: TextStream;
    /** Leading tokens held back until they contain something worth showing —
     * models often emit whitespace first, and a message created from that
     * would render as an empty bubble (then seal to a stray "…"). */
    pendingHead?: string;
    /** toolCallId → the message showing that call, so a failure can edit it. */
    toolMsgs: Map<string, { messageId: number; html: string }>;
    /** Keeps the Telegram "typing…" cue alive while the turn runs. */
    typingTimer?: ReturnType<typeof setInterval>;
    /** True once any message (tool or text) has been sent this turn. */
    sentAny: boolean;
    done: boolean;
}

/** Telegram clears a chat action after ~5s; refresh it a little sooner. */
const TYPING_REFRESH_MS = 4000;
/** Min gap between live edits of a streaming message — Telegram rate-limits
 * edits to roughly one per second per message; 1.5s keeps comfortable margin. */
const EDIT_INTERVAL_MS = 1500;

/** A prompt waiting to run. `interrupt` marks one that displaced the turn in
 * flight (a plain message sent mid-turn) — those keep their arrival order ahead
 * of anything explicitly /queue'd. */
interface QueuedPrompt {
    text: string;
    images: { data: string; mediaType: string }[];
    interrupt: boolean;
}

interface SessionListRow {
    id: string;
    name?: string;
    firstUserMessage?: string;
    mtime: number;
    running?: boolean;
}

export interface TelegramBridgeOpts {
    api: TelegramApiLike;
    rpc: RpcAttachable;
    /** Paired chat from the store; undefined until /start <code> claims it. */
    chatId?: number;
    pairCode?: string;
    /** Default cwd for sessions created from chat (the daemon's cwd). */
    cwd?: string;
    onPaired?: (chatId: number) => void;
    log?: (line: string) => void;
}

export class TelegramBridge {
    private readonly api: TelegramApiLike;
    private peer: RpcPeer;
    private chatId?: number;
    private pairCode?: string;
    private cwd: string;
    private log: (line: string) => void;
    private onPairedCb?: (chatId: number) => void;

    private stopped = false;
    private offset: number | undefined;
    private defaultModel: string | null = null;

    // Per-chat conversation state (a single paired chat by design).
    private sessionId?: string;
    private model?: string;
    private provider?: string;
    private thinking?: ThinkingLevel;
    private live?: LiveTurn;
    /** Ordered model list backing the open /model menu (mdl:<idx> taps). */
    private modelList?: ModelRow[];
    /** Prompts waiting for the current turn to end (see QueuedPrompt). */
    private queue: QueuedPrompt[] = [];
    /** Set while an interrupt-cancel is in flight, so finalizeTurn reports the
     * abort as an interruption instead of an error. */
    private interrupting = false;
    /** Serializes turn-event handling: sends (tool messages, prose, footer)
     * must land in arrival order, so each event handler runs after the last
     * one settles rather than racing on the microtask queue. */
    private eventQueue: Promise<void> = Promise.resolve();

    constructor(opts: TelegramBridgeOpts) {
        this.api = opts.api;
        this.peer = new RpcPeer(opts.rpc);
        this.peer.onNotification = (method, params) => {
            if (method === "session.event")
                this.onSessionEvent(params as { sessionId: string; part: { type: string; data: unknown } });
        };
        this.chatId = opts.chatId;
        this.pairCode = opts.pairCode;
        this.cwd = opts.cwd ?? process.cwd();
        this.onPairedCb = opts.onPaired;
        this.log = opts.log ?? (() => {});
    }

    /** Validate the token, register the command menu, and read server
     * defaults — everything that must succeed before we commit to polling.
     * Throws on a bad token so the caller can report it synchronously. */
    async startAndValidate(): Promise<TgUser> {
        const me = await this.api.getMe();
        await this.api.setMyCommands(BOT_COMMANDS);
        const info = await this.peer.call<{ defaults?: { model?: string | null } }>("server.info");
        this.defaultModel = info.defaults?.model ?? null;
        return me;
    }

    /** Poll until stop(). Call after startAndValidate() has succeeded. */
    pollForever(): Promise<void> {
        return this.pollLoop();
    }

    /** Validate then poll — the all-in-one path for tests and simple callers. */
    async run(): Promise<TgUser> {
        const me = await this.startAndValidate();
        await this.pollLoop();
        return me;
    }

    stop(): void {
        this.stopped = true;
        // Clear the typing interval too — stopping mid-turn would otherwise
        // leave a repeating timer holding the event loop open.
        this.stopTyping();
        if (this.live) this.live.done = true;
        this.peer.close();
    }

    private async pollLoop(): Promise<void> {
        while (!this.stopped) {
            try {
                const updates = await this.api.getUpdates({ offset: this.offset, timeoutSec: 50 });
                for (const update of updates) {
                    this.offset = update.update_id + 1;
                    await this.handleUpdate(update);
                }
            } catch (err) {
                if (this.stopped) return;
                if (err instanceof TelegramApiError && err.code === 409) {
                    this.log("another poller is consuming this bot (409) — only one bridge can run per token");
                    await sleep(10_000);
                } else {
                    this.log(`poll error: ${(err as Error).message}`);
                    await sleep(3000);
                }
            }
        }
    }

    /** Public for tests: one update through the full router. */
    async handleUpdate(update: TgUpdate): Promise<void> {
        try {
            if (update.message) await this.handleMessage(update.message);
            else if (update.callback_query) await this.handleCallback(update.callback_query);
        } catch (err) {
            this.log(`update failed: ${(err as Error).message}`);
            if (this.chatId) {
                await this.replySafe(`error: ${(err as Error).message}`);
            }
        }
    }

    private paired(id: number): boolean {
        return this.chatId !== undefined && this.chatId === id;
    }

    private reply(text: string, opts: { html?: boolean; keyboard?: InlineKeyboard } = {}): Promise<TgMessage> {
        if (this.chatId === undefined) throw new Error("no paired chat");
        return this.api.sendMessage({ chatId: this.chatId, text, html: opts.html, keyboard: opts.keyboard });
    }

    /** Reply that never throws — for error paths and HTML fallbacks. */
    private async replySafe(text: string, opts: { html?: boolean; keyboard?: InlineKeyboard } = {}): Promise<void> {
        try {
            await this.reply(text, opts);
        } catch (err) {
            if (opts.html && isParseError(err)) {
                try {
                    await this.reply(htmlToPlain(text));
                    return;
                } catch {}
            }
            this.log(`send failed: ${(err as Error).message}`);
        }
    }

    private async handleMessage(msg: TgMessage): Promise<void> {
        const from = msg.chat.id;
        const raw = (msg.text ?? msg.caption ?? "").trim();

        if (raw.startsWith("/start")) {
            await this.handleStart(from, raw);
            return;
        }
        if (!this.paired(from)) {
            // Human-triggered, so a reply per attempt can't loop; don't leak
            // whether the bridge is paired.
            await this.api.sendMessage({ chatId: from, text: "not authorized" }).catch(() => {});
            return;
        }

        if (raw.startsWith("/")) {
            const m = raw.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?\s*([\s\S]*)$/);
            const name = m?.[1]?.toLowerCase() ?? "";
            const args = m?.[2]?.trim() ?? "";
            const resolved = COMMAND_ALIASES[name] ?? name;
            if (
                resolved !== "start" &&
                (BOT_COMMANDS.some((c) => c.command === resolved) || resolved in COMMAND_ALIASES)
            ) {
                await this.runCommand(resolved, args);
            } else {
                await this.replySafe(`unknown command /${name} — /help lists what works here`);
            }
            return;
        }

        // Plain text (and/or photos): a prompt to the active session.
        const images = await this.collectImages(msg);
        if (!raw && images.length === 0) return;
        await this.sendPrompt(raw, images);
    }

    private async handleStart(from: number, raw: string): Promise<void> {
        if (this.paired(from)) {
            await this.replySafe("already connected — send a message to talk to the agent, /help for commands");
            return;
        }
        if (this.chatId !== undefined) {
            await this.api.sendMessage({ chatId: from, text: "not authorized" }).catch(() => {});
            return;
        }
        const code = raw.split(/\s+/)[1] ?? "";
        if (!this.pairCode) {
            // Bridge is polling but there's no unclaimed code — setup isn't
            // finished, or a previous pairing already burned it.
            await this.api
                .sendMessage({
                    chatId: from,
                    text:
                        `this bot isn't ready to pair. In ${PRODUCT_NAME} on your computer, run ` +
                        `/gateways → Telegram to generate a pairing link, then tap it here.`,
                })
                .catch(() => {});
            return;
        }
        if (code !== this.pairCode) {
            // Almost always a bare /start: Telegram's START button (and typing
            // /start by hand) sends no code. The code only rides the deep link,
            // which the operator opens from the TUI — never echo it here, or
            // anyone who messages the bot could pair.
            await this.api
                .sendMessage({
                    chatId: from,
                    text:
                        "to connect, open the pairing link from your computer — in " +
                        `${PRODUCT_NAME}: /gateways → Telegram → “show pairing link” — and tap it. ` +
                        "Pressing START here by hand won't work: the link carries a one-time code that this message is missing.",
                })
                .catch(() => {});
            return;
        }
        this.chatId = from;
        this.pairCode = undefined;
        this.onPairedCb?.(from);
        this.log(`paired with chat ${from}`);
        await this.replySafe(
            "connected. send a message to talk to the agent — it runs with full shell access on the host machine.\n" +
                "/help lists commands, /new starts a fresh session, /cancel stops a running turn",
        );
    }

    private async collectImages(msg: TgMessage): Promise<{ data: string; mediaType: string }[]> {
        // Telegram sends multiple sizes per photo, smallest first — take the
        // largest. Photos are always jpeg.
        const best = msg.photo?.at(-1);
        if (!best) return [];
        const { data } = await this.api.getFileBase64(best.file_id);
        return [{ data, mediaType: "image/jpeg" }];
    }

    // ---- prompt & live turn -------------------------------------------------

    /**
     * A plain message sent mid-turn INTERRUPTS: Telegram has no Esc key, so the
     * natural way to redirect the agent is to just say the next thing. The
     * running turn is cancelled and this prompt runs as soon as it unwinds.
     * `/queue` is the explicit "wait your turn" path.
     */
    private async interruptWith(prompt: QueuedPrompt): Promise<void> {
        // Insert after any interrupts already waiting (preserving the order the
        // user typed them) but ahead of everything explicitly queued.
        const firstQueued = this.queue.findIndex((q) => !q.interrupt);
        this.queue.splice(firstQueued === -1 ? this.queue.length : firstQueued, 0, prompt);
        if (this.interrupting) return; // a cancel is already unwinding the turn
        this.interrupting = true;
        await this.replySafe("<i>interrupting…</i>", { html: true });
        try {
            await this.peer.call("session.cancel", { sessionId: this.sessionId });
        } catch (err) {
            this.log(`interrupt cancel failed: ${(err as Error).message}`);
        }
    }

    /** Drop the turn in flight because the session it belongs to is going away
     * (/new, session switch). Cancels it server-side — otherwise it keeps
     * running and burning tokens with its output going nowhere — and stops the
     * typing cue, whose interval would otherwise outlive the LiveTurn holding it. */
    private async abandonTurn(): Promise<void> {
        const live = this.live;
        if (!live) return;
        this.stopTyping(); // reads this.live, so before clearing it
        live.done = true;
        this.live = undefined;
        this.interrupting = false;
        if (this.sessionId) {
            await this.peer.call("session.cancel", { sessionId: this.sessionId }).catch(() => {});
        }
    }

    /** Run the next waiting prompt, if the turn slot is free. */
    private async drainQueue(): Promise<void> {
        if (this.live || !this.queue.length) return;
        const next = this.queue.shift()!;
        try {
            await this.sendPrompt(next.text, next.images);
        } catch (err) {
            // Nobody is watching the daemon log, and the send happened without a
            // message of the user's to answer — report it in chat, then carry on
            // with the rest of the queue rather than stranding it.
            await this.replySafe(`queued message failed to start: ${(err as Error).message}`);
            await this.drainQueue();
        }
    }

    private async sendPrompt(text: string, images: { data: string; mediaType: string }[] = []): Promise<void> {
        // A turn in flight (including one mid-finalization) is interrupted, not
        // refused — see interruptWith.
        if (this.live) {
            await this.interruptWith({ text, images, interrupt: true });
            return;
        }
        const model = this.model ?? this.defaultModel;
        if (!model) {
            await this.replySafe("no model configured — pick one with /model first");
            return;
        }
        if (!this.sessionId) {
            const created = await this.peer.call<{ sessionId: string }>("session.create", {
                cwd: this.cwd,
                model,
                ...(this.provider ? { provider: this.provider } : {}),
            });
            this.sessionId = created.sessionId;
            await this.peer.call("session.attach", { sessionId: this.sessionId });
        }
        // Arm the live turn BEFORE session.send: the server starts streaming as
        // soon as it accepts, and onSessionEvent drops events while `live` is
        // unset — setting it afterwards can lose the turn's first tokens.
        this.live = {
            startedAt: Date.now(),
            toolMsgs: new Map(),
            sentAny: false,
            done: false,
        };
        this.startTyping();
        try {
            await this.peer.call("session.send", {
                sessionId: this.sessionId,
                input: text,
                model,
                ...(this.thinking ? { thinking: this.thinking } : {}),
                ...(images.length ? { images } : {}),
            });
        } catch (err) {
            // The turn never started — tear the live state down, or every later
            // message would be refused with "a turn is already running".
            this.stopTyping();
            this.live = undefined;
            throw err;
        }
    }

    /** Send an HTML message, falling back to plain text if Telegram rejects the
     * markup, and return the sent message (for later edits) or undefined. */
    private async sendHtml(text: string): Promise<TgMessage | undefined> {
        try {
            return await this.reply(text, { html: true });
        } catch (err) {
            if (isParseError(err)) {
                try {
                    return await this.reply(htmlToPlain(text));
                } catch {}
            }
            this.log(`send failed: ${(err as Error).message}`);
            return undefined;
        }
    }

    private startTyping(): void {
        if (this.chatId === undefined) return;
        this.api.sendChatAction(this.chatId).catch(() => {});
        this.live!.typingTimer = setInterval(() => {
            if (!this.live || this.live.done) return;
            this.api.sendChatAction(this.chatId!).catch(() => {});
        }, TYPING_REFRESH_MS);
    }

    private stopTyping(): void {
        if (this.live?.typingTimer) {
            clearInterval(this.live.typingTimer);
            this.live.typingTimer = undefined;
        }
    }

    /** Grow the current streaming text block by `chunk`, live-editing its
     * Telegram message (throttled). Creates the message on the first token, and
     * rolls to a new message when the active one fills — the whole answer
     * streams, however long, with nothing truncated. */
    private async streamText(chunk: string): Promise<void> {
        const live = this.live;
        if (!live || live.done || !chunk) return;
        if (!live.stream) {
            // Hold back until there's non-whitespace to show.
            live.pendingHead = (live.pendingHead ?? "") + chunk;
            if (!live.pendingHead.trim()) return;
            const head = live.pendingHead;
            live.pendingHead = undefined;
            const preview = streamPreview(head);
            const msg = await this.sendHtml(preview);
            if (!msg) return;
            live.stream = {
                messageId: msg.message_id,
                text: head,
                committedLen: 0,
                sent: preview,
                lastEditAt: Date.now(),
            };
            live.sentAny = true;
            return;
        }
        live.stream.text += chunk;
        // Active (uncommitted) portion outgrew one message → seal it and open a
        // fresh streaming message for the remainder before it can overflow.
        while (live.stream.text.length - live.stream.committedLen > STREAM_SOFT_LIMIT) {
            if (!(await this.rollStream())) break;
        }
        if (Date.now() - live.stream.lastEditAt >= EDIT_INTERVAL_MS) await this.pushStreamEdit();
    }

    /** The uncommitted tail of the streaming block — what the active message shows. */
    private activeStreamText(): string {
        const s = this.live!.stream!;
        return s.text.slice(s.committedLen);
    }

    /** Push the current streaming preview to the active message (skip no-ops). */
    private async pushStreamEdit(): Promise<void> {
        const live = this.live;
        if (!live?.stream) return;
        const preview = streamPreview(this.activeStreamText());
        if (preview === live.stream.sent) return;
        live.stream.sent = preview;
        live.stream.lastEditAt = Date.now();
        try {
            await this.api.editMessageText({
                chatId: this.chatId!,
                messageId: live.stream.messageId,
                text: preview,
                html: true,
            });
        } catch (err) {
            if (!isNotModifiedError(err)) this.log(`stream edit failed: ${(err as Error).message}`);
        }
    }

    /** Seal the active message at a line boundary and continue the block in a
     * new streaming message. Returns false if a new message couldn't be sent
     * (so the caller stops looping). */
    private async rollStream(): Promise<boolean> {
        const live = this.live;
        if (!live?.stream) return false;
        const active = this.activeStreamText();
        const cut = streamCut(active);
        const head = active.slice(0, cut);
        // Seal this message with fully-rendered markdown — the same treatment
        // sealStream gives the final block. Passing raw text with html:true
        // would leave it unformatted (or trip Telegram's HTML parser).
        const chunks = markdownToTelegramChunks(head.trim() || "…");
        await this.finalizeMessage(live.stream.messageId, chunks[0]);
        for (let i = 1; i < chunks.length; i++) await this.sendHtml(chunks[i]);
        live.stream.committedLen += head.length;
        const rest = this.activeStreamText();
        const preview = streamPreview(rest);
        const msg = await this.sendHtml(preview);
        if (!msg) {
            live.stream = undefined;
            return false;
        }
        live.stream.messageId = msg.message_id;
        live.stream.sent = preview;
        live.stream.lastEditAt = Date.now();
        return true;
    }

    /** Finish the current text block: re-render its remaining active text as
     * full markdown into the active message (plus overflow messages), and clear
     * the stream so the next block starts fresh. */
    private async sealStream(): Promise<void> {
        const live = this.live;
        if (!live?.stream) return;
        const { messageId } = live.stream;
        const active = this.activeStreamText();
        live.stream = undefined;
        const chunks = markdownToTelegramChunks(active.trim() || "…");
        await this.finalizeMessage(messageId, chunks[0]);
        for (let i = 1; i < chunks.length; i++) await this.sendHtml(chunks[i]);
    }

    /** Replace a streamed message's content with its final HTML, falling back to
     * plain text if Telegram rejects the markup. */
    private async finalizeMessage(messageId: number, html: string): Promise<void> {
        try {
            await this.api.editMessageText({ chatId: this.chatId!, messageId, text: html, html: true });
        } catch (err) {
            if (isParseError(err)) {
                await this.api
                    .editMessageText({ chatId: this.chatId!, messageId, text: htmlToPlain(html) })
                    .catch(() => {});
            } else if (!isNotModifiedError(err)) {
                this.log(`finalize edit failed: ${(err as Error).message}`);
            }
        }
    }

    /** Run turn-event handlers one at a time, in the order events arrived. */
    private enqueue(fn: () => Promise<void> | void): void {
        this.eventQueue = this.eventQueue
            .then(fn)
            .catch((err) => this.log(`event handler failed: ${(err as Error).message}`));
    }

    private onSessionEvent(params: { sessionId: string; part: { type: string; data: unknown } }): void {
        if (params.sessionId !== this.sessionId || !this.live || this.live.done) return;
        const { type, data } = params.part;
        switch (type) {
            case "text-delta": {
                const chunk = String(data);
                this.enqueue(() => this.streamText(chunk));
                break;
            }
            case "tool-call": {
                const d = data as { toolName?: string; input?: unknown; toolCallId?: string };
                this.enqueue(() => this.onToolCall(d.toolCallId, d.toolName, d.input));
                break;
            }
            case "tool-error": {
                const d = data as { toolCallId?: string; toolName?: string; error?: unknown };
                this.enqueue(() => this.onToolError(d.toolCallId, d.toolName, d.error));
                break;
            }
            case "subagent-tool": {
                const d = data as { agent: string; toolName?: string; input?: unknown };
                this.enqueue(() => this.onToolCall(undefined, d.toolName, d.input, d.agent));
                break;
            }
            case "compact-start":
                this.enqueue(async () => {
                    await this.sendHtml("<i>compacting context…</i>");
                    if (this.live) this.live.sentAny = true;
                });
                break;
            case "finish":
                this.enqueue(() => this.finalizeTurn());
                break;
            case "error":
                this.enqueue(() => this.finalizeTurn(String(data)));
                break;
            default:
                break;
        }
    }

    /** A tool started: seal any streaming prose before it (keeps order), then
     * post the call as its own message. */
    private async onToolCall(
        toolCallId: string | undefined,
        toolName: string | undefined,
        input: unknown,
        agent?: string,
    ): Promise<void> {
        const live = this.live;
        if (!live || live.done) return;
        await this.sealStream();
        const html = toolMessageHtml(toolName, input, agent);
        const msg = await this.sendHtml(html);
        live.sentAny = true;
        if (msg && toolCallId) live.toolMsgs.set(toolCallId, { messageId: msg.message_id, html });
    }

    /** A tool failed: mark its message (or post a standalone failure). */
    private async onToolError(
        toolCallId: string | undefined,
        toolName: string | undefined,
        error: unknown,
    ): Promise<void> {
        const live = this.live;
        if (!live || live.done) return;
        const line = `<i>failed: ${escapeHtml(truncate(String(error ?? ""), 160))}</i>`;
        const entry = toolCallId ? live.toolMsgs.get(toolCallId) : undefined;
        if (entry) {
            try {
                await this.api.editMessageText({
                    chatId: this.chatId!,
                    messageId: entry.messageId,
                    text: `${entry.html}\n${line}`,
                    html: true,
                });
            } catch (err) {
                if (!isNotModifiedError(err)) this.log(`tool-error edit failed: ${(err as Error).message}`);
            }
        } else {
            await this.sendHtml(`${toolMessageHtml(toolName, undefined)}\n${line}`);
            live.sentAny = true;
        }
    }

    private async finalizeTurn(error?: string): Promise<void> {
        const live = this.live;
        if (!live || live.done) return;
        this.stopTyping();
        // Seal the final prose block BEFORE flipping `done` — sealStream and the
        // streaming edits both guard on `done`, and the last block must land.
        await this.sealStream();
        live.done = true;

        const elapsed = Math.round((Date.now() - live.startedAt) / 1000);
        let footer = `${elapsed}s`;
        try {
            const cost = await this.peer.call<CostBreakdown>("cost.session", { sessionId: this.sessionId });
            if (cost.usd > 0) footer += ` · ${cost.estimated ? "~" : ""}$${cost.usd.toFixed(4)}`;
        } catch {}

        if (error && !this.interrupting) {
            await this.sendHtml(`<i>error: ${escapeHtml(truncate(error, 300))}</i>`);
        } else if (!error && !live.sentAny) {
            // A turn that produced neither prose nor tools — acknowledge it.
            await this.sendHtml("<i>(no output)</i>");
        }
        // An interrupt's abort is expected, not an error worth a footer either.
        if (!this.interrupting) await this.sendHtml(`<i>${escapeHtml(footer)}</i>`);
        // Only clear if still ours — defensive against any future path that
        // could replace this.live while we awaited above.
        if (this.live === live) this.live = undefined;
        this.interrupting = false;
        // Hand the freed slot to whatever was waiting.
        await this.drainQueue();
    }

    /** After switching to a session, replay its recent transcript to the chat
     * so the resumed conversation has visible context (not just an id). Capped;
     * /export ships the full thing. Best-effort — a render failure is logged,
     * never fatal to the switch. */
    private async replayTranscript(sessionId: string): Promise<void> {
        try {
            const h = await this.peer.call<{ name?: string; entries: unknown[] }>("session.history", { sessionId });
            const parts = sessionTranscriptMessages(h.entries as never[], { name: h.name });
            for (const part of parts) await this.sendHtml(part);
        } catch (err) {
            this.log(`transcript replay failed: ${(err as Error).message}`);
        }
    }

    // ---- commands -----------------------------------------------------------

    /** Models the user can actually run right now: those whose provider is
     * logged in (auth.status) and that the catalog marks available — mirroring
     * loop's own model picker, which never offers an unauthenticated provider. */
    private async authorizedModels(provider?: string): Promise<ModelRow[]> {
        const [auth, models] = await Promise.all([
            this.peer.call<{ providers: string[] }>("auth.status"),
            this.peer.call<(ModelRow & { available?: boolean })[]>("catalog.list", provider ? { provider } : undefined),
        ]);
        const authed = new Set(auth.providers ?? []);
        return models.filter((m) => authed.has(m.provider) && m.available !== false);
    }

    private async runCommand(name: string, args: string): Promise<void> {
        switch (name) {
            case "help": {
                const lines = BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`);
                lines.push(
                    "",
                    "plain messages go to the agent; photos are attached as images",
                    "sending a message while it's working INTERRUPTS the turn and runs yours instead",
                    "use /queue <message> to run it after the current turn instead of interrupting",
                );
                await this.replySafe(lines.join("\n"));
                return;
            }
            case "new": {
                // Cancel (not just forget) a turn still running on the old
                // session before letting go of it.
                await this.abandonTurn();
                this.sessionId = undefined;
                // A fresh session must not inherit prompts aimed at the old one.
                this.queue = [];
                await this.replySafe("new session — send a message to start it");
                return;
            }
            case "sessions": {
                const rows = await this.peer.call<SessionListRow[]>("session.list");
                const recent = rows.sort((a, b) => b.mtime - a.mtime).slice(0, 10);
                if (!recent.length) {
                    await this.replySafe("no sessions yet");
                    return;
                }
                await this.replySafe("pick a session", {
                    keyboard: sessionsKeyboard(
                        recent.map((r) => ({
                            id: r.id,
                            label: r.name || r.firstUserMessage || r.id,
                            running: r.running,
                        })),
                    ),
                });
                return;
            }
            case "session": {
                if (!this.sessionId) {
                    await this.replySafe("no active session — send a message or /sessions to pick one");
                    return;
                }
                const h = await this.peer.call<{
                    info: { id: string; cwd: string; provider: string; model: string };
                    name?: string;
                    entries: unknown[];
                    running: boolean;
                }>("session.history", { sessionId: this.sessionId });
                const lines = [
                    `id        ${h.info.id}`,
                    `name      ${h.name || "(unnamed)"}`,
                    `model     ${this.model ?? this.defaultModel ?? h.info.model}`,
                    `cwd       ${h.info.cwd}`,
                    `entries   ${h.entries.length}`,
                    `running   ${h.running ? "yes" : "no"}`,
                ];
                await this.replySafe(`<pre>${escapeHtml(lines.join("\n"))}</pre>`, { html: true });
                return;
            }
            case "name": {
                if (!args) {
                    await this.replySafe("usage: /name <new name>");
                    return;
                }
                if (!this.sessionId) {
                    await this.replySafe("no active session to rename");
                    return;
                }
                await this.peer.call("session.rename", { sessionId: this.sessionId, name: args });
                await this.replySafe(`renamed: ${args}`);
                return;
            }
            case "cancel": {
                // Stop everything: the running turn AND anything waiting, so
                // /cancel can't be followed by a surprise queued turn.
                const dropped = this.queue.length;
                this.queue = [];
                if (!this.sessionId || !this.live) {
                    await this.replySafe(dropped ? `nothing running — dropped ${dropped} queued` : "nothing to cancel");
                    return;
                }
                await this.peer.call("session.cancel", { sessionId: this.sessionId });
                await this.replySafe(dropped ? `cancelled · dropped ${dropped} queued` : "cancelled");
                return;
            }
            case "queue": {
                const sub = args.trim();
                if (sub === "clear") {
                    const n = this.queue.length;
                    this.queue = [];
                    await this.replySafe(n ? `queue cleared (${n} dropped)` : "queue was already empty");
                    return;
                }
                if (!sub) {
                    if (!this.queue.length) {
                        await this.replySafe("queue is empty — /queue <message> adds one");
                        return;
                    }
                    const lines = this.queue.map((q, i) => `${i + 1}. ${truncate(q.text || "(image)", 60)}`);
                    await this.replySafe(`<b>queued</b>\n${escapeHtml(lines.join("\n"))}`, { html: true });
                    return;
                }
                this.queue.push({ text: sub, images: [], interrupt: false });
                // With nothing running the queue drains immediately, so say what
                // actually happened rather than claiming it's waiting.
                if (!this.live) {
                    await this.replySafe("nothing running — starting it now");
                    await this.drainQueue();
                    return;
                }
                await this.replySafe(`queued (position ${this.queue.length}) — runs after this turn`);
                return;
            }
            case "compact": {
                if (!this.sessionId) {
                    await this.replySafe("no active session to compact");
                    return;
                }
                const r = await this.peer.call<{ tokensBefore: number; tokensAfter?: number }>("session.compact", {
                    sessionId: this.sessionId,
                });
                await this.replySafe(
                    r.tokensBefore > 0
                        ? `compacted: ~${r.tokensBefore} → ~${r.tokensAfter ?? 0} tokens`
                        : "nothing to compact yet",
                );
                return;
            }
            case "model": {
                const models = await this.authorizedModels();
                if (!models.length) {
                    await this.replySafe(
                        `no providers are logged in. Run \`${PRODUCT_NAME} login\` on your computer, then /model here.`,
                    );
                    return;
                }
                if (args) {
                    const hit = models.find((m) => m.id === args || m.id.endsWith(`/${args}`));
                    if (!hit) {
                        await this.replySafe(`unknown or unavailable model: ${args}`);
                        return;
                    }
                    this.model = hit.id;
                    this.provider = hit.provider;
                    await this.replySafe(`model set: ${hit.id}`);
                    return;
                }
                await this.replySafe("pick a provider", { keyboard: providerKeyboard(models) });
                return;
            }
            case "thinking": {
                if (args) {
                    if (!THINKING_LEVELS.includes(args as ThinkingLevel)) {
                        await this.replySafe(`thinking level must be one of: ${THINKING_LEVELS.join(", ")}`);
                        return;
                    }
                    this.thinking = args as ThinkingLevel;
                    await this.replySafe(`thinking: ${args}`);
                    return;
                }
                await this.replySafe("pick a thinking level", {
                    keyboard: thinkingKeyboard(THINKING_LEVELS, this.thinking),
                });
                return;
            }
            case "settings": {
                const rows = await this.peer.call<{ key: string; label: string; value: boolean }[]>("settings.list");
                await this.replySafe("settings — tap to toggle", { keyboard: settingsKeyboard(rows) });
                return;
            }
            case "extensions": {
                const rows = await this.peer.call<{ name: string; enabled: boolean }[]>("extension.list");
                if (!rows.length) {
                    await this.replySafe("no extensions installed");
                    return;
                }
                await this.replySafe("extensions — tap to toggle", { keyboard: extensionsKeyboard(rows) });
                return;
            }
            case "cost": {
                const stats = await this.peer.call<CostStats>("cost.stats", { cwd: this.cwd });
                let session: CostBreakdown | undefined;
                if (this.sessionId) {
                    try {
                        session = await this.peer.call<CostBreakdown>("cost.session", { sessionId: this.sessionId });
                    } catch {}
                }
                await this.replySafe(formatCost(stats, session), { html: true });
                return;
            }
            case "context": {
                const report = await this.peer.call<ContextReport>("context.report", {
                    ...(this.sessionId ? { sessionId: this.sessionId } : { cwd: this.cwd }),
                    model: this.model ?? this.defaultModel ?? undefined,
                });
                await this.replySafe(formatContext(report), { html: true });
                return;
            }
            case "steak": {
                const year = /^\d{4}$/.test(args) ? Number(args) : undefined;
                const grid = await this.peer.call<SteakGrid>("usage.steak", year ? { year } : {});
                await this.replySafe(formatSteak(grid), { html: true });
                return;
            }
            case "export": {
                if (!this.sessionId) {
                    await this.replySafe("no active session to export");
                    return;
                }
                const h = await this.peer.call<{ entries: unknown[] }>("session.history", {
                    sessionId: this.sessionId,
                });
                const jsonl = h.entries.map((e) => JSON.stringify(e)).join("\n");
                if (!jsonl) {
                    // Telegram rejects a zero-byte document upload.
                    await this.replySafe("nothing to export yet — this session has no entries");
                    return;
                }
                await this.api.sendDocument({
                    chatId: this.chatId!,
                    filename: `${this.sessionId}.jsonl`,
                    content: jsonl,
                    caption: `${h.entries.length} entries`,
                });
                return;
            }
            case "cd": {
                if (!args) {
                    await this.replySafe(`cwd: ${this.cwd}`);
                    return;
                }
                const target = resolve(this.cwd, args);
                if (!existsSync(target) || !statSync(target).isDirectory()) {
                    await this.replySafe(`not a directory: ${target}`);
                    return;
                }
                this.cwd = target;
                await this.replySafe(`cwd: ${target} (applies to new sessions — /new)`);
                return;
            }
            case "status": {
                const lines = [
                    `session   ${this.sessionId ?? "(none)"}`,
                    `model     ${this.model ?? this.defaultModel ?? "(unset)"}`,
                    `thinking  ${this.thinking ?? "(default)"}`,
                    `cwd       ${this.cwd}`,
                    `turn      ${this.live && !this.live.done ? "running" : "idle"}`,
                    `queued    ${this.queue.length}`,
                ];
                await this.replySafe(`<pre>${escapeHtml(lines.join("\n"))}</pre>`, { html: true });
                return;
            }
            case "init": {
                await this.sendPrompt(INIT_PROMPT);
                return;
            }
            default:
                await this.replySafe(`unknown command /${name}`);
        }
    }

    // ---- inline keyboard callbacks ------------------------------------------

    private async handleCallback(cb: TgCallbackQuery): Promise<void> {
        const chat = cb.message?.chat.id ?? cb.from.id;
        if (!this.paired(chat)) {
            await this.api.answerCallbackQuery(cb.id, "not authorized").catch(() => {});
            return;
        }
        const ack = (text?: string) => this.api.answerCallbackQuery(cb.id, text).catch(() => {});
        const data = cb.data ?? "";
        const sep = data.indexOf(":");
        const prefix = sep < 0 ? data : data.slice(0, sep);
        const value = sep < 0 ? "" : data.slice(sep + 1);
        const msg = cb.message;

        switch (prefix) {
            case "set": {
                const rows = await this.peer.call<{ key: string; label: string; value: boolean }[]>("settings.list");
                const row = rows.find((r) => r.key === value);
                if (!row) {
                    await ack("unknown setting");
                    return;
                }
                await this.peer.call("settings.set", { key: row.key, value: !row.value });
                row.value = !row.value;
                if (msg) {
                    await this.api
                        .editMessageText({
                            chatId: chat,
                            messageId: msg.message_id,
                            text: "settings — tap to toggle",
                            keyboard: settingsKeyboard(rows),
                        })
                        .catch(() => {});
                }
                await ack(`${row.label}: ${row.value ? "on" : "off"}`);
                return;
            }
            case "prov": {
                const models = await this.authorizedModels(value);
                if (!models.length) {
                    // Logged out (or the provider lost availability) between
                    // opening the menu and tapping it.
                    await ack("no models available for that provider");
                    return;
                }
                this.modelList = models;
                if (msg) {
                    await this.api
                        .editMessageText({
                            chatId: chat,
                            messageId: msg.message_id,
                            text: `${value} — pick a model`,
                            keyboard: modelKeyboard(models, this.model),
                        })
                        .catch(() => {});
                }
                await ack();
                return;
            }
            case "mdl": {
                const hit = this.modelList?.[Number(value)];
                if (!hit) {
                    await ack("menu expired — /model again");
                    return;
                }
                this.model = hit.id;
                this.provider = hit.provider;
                if (msg) {
                    await this.api
                        .editMessageText({
                            chatId: chat,
                            messageId: msg.message_id,
                            text: `model set: ${hit.id}`,
                        })
                        .catch(() => {});
                }
                await ack("model set");
                return;
            }
            case "ses": {
                const previous = this.sessionId;
                // Same as /new: don't leave a turn running on the session we're
                // switching away from.
                await this.abandonTurn();
                await this.peer.call("session.open", { sessionId: value });
                await this.peer.call("session.attach", { sessionId: value });
                if (previous && previous !== value) {
                    await this.peer.call("session.detach", { sessionId: previous }).catch(() => {});
                }
                this.sessionId = value;
                // Prompts queued for the previous session don't carry over.
                this.queue = [];
                if (msg) {
                    await this.api
                        .editMessageText({ chatId: chat, messageId: msg.message_id, text: `session: ${value}` })
                        .catch(() => {});
                }
                await ack("session switched");
                await this.replayTranscript(value);
                return;
            }
            case "thk": {
                if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
                    await ack("unknown level");
                    return;
                }
                this.thinking = value as ThinkingLevel;
                if (msg) {
                    await this.api
                        .editMessageText({ chatId: chat, messageId: msg.message_id, text: `thinking: ${value}` })
                        .catch(() => {});
                }
                await ack(`thinking: ${value}`);
                return;
            }
            case "ext": {
                const rows = await this.peer.call<{ name: string; enabled: boolean }[]>("extension.list");
                const row = rows.find((r) => r.name === value);
                if (!row) {
                    await ack("unknown extension");
                    return;
                }
                await this.peer.call("extension.setEnabled", { name: row.name, value: !row.enabled });
                row.enabled = !row.enabled;
                if (msg) {
                    await this.api
                        .editMessageText({
                            chatId: chat,
                            messageId: msg.message_id,
                            text: "extensions — tap to toggle",
                            keyboard: extensionsKeyboard(rows),
                        })
                        .catch(() => {});
                }
                await ack(`${row.name}: ${row.enabled ? "on" : "off"}`);
                return;
            }
            default:
                await ack();
        }
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
