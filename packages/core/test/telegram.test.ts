import { describe, expect, test } from "bun:test";
import { TelegramApi, TelegramApiError, isParseError, isNotModifiedError, type TgUpdate } from "../src/telegram/api";
import {
    markdownToTelegramChunks,
    htmlToPlain,
    toolLine,
    truncate,
    escapeHtml,
    formatCost,
    formatContext,
    formatSteak,
    CHUNK_LIMIT,
} from "../src/telegram/render";
import { settingsKeyboard, modelKeyboard, thinkingKeyboard } from "../src/telegram/menus";
import { TelegramBridge, type RpcAttachable, type TelegramApiLike } from "../src/telegram/bridge";
import type { RpcNotification, RpcResponse } from "../src/rpc/protocol";

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 4) => {
    for (let i = 0; i < n; i++) await tick();
};

// ---- api client ------------------------------------------------------------

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("TelegramApi", () => {
    test("getMe unwraps the ok envelope", async () => {
        const calls: { url: string; body: unknown }[] = [];
        const api = new TelegramApi("TOKEN", async (url, init) => {
            calls.push({ url, body: JSON.parse(String(init?.body)) });
            return jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: "b", username: "mybot" } });
        });
        const me = await api.getMe();
        expect(me.username).toBe("mybot");
        expect(calls[0].url).toBe("https://api.telegram.org/botTOKEN/getMe");
    });

    test("sendMessage shapes chat_id, HTML parse mode, and inline keyboard", async () => {
        let sent: Record<string, unknown> = {};
        const api = new TelegramApi("T", async (_url, init) => {
            sent = JSON.parse(String(init?.body));
            return jsonResponse({ ok: true, result: { message_id: 7, chat: { id: 5, type: "private" } } });
        });
        const msg = await api.sendMessage({
            chatId: 5,
            text: "<b>hi</b>",
            html: true,
            keyboard: [[{ text: "ok", callback_data: "x" }]],
        });
        expect(msg.message_id).toBe(7);
        expect(sent.chat_id).toBe(5);
        expect(sent.parse_mode).toBe("HTML");
        expect(sent.reply_markup).toEqual({ inline_keyboard: [[{ text: "ok", callback_data: "x" }]] });
    });

    test("retries once after a 429 with retry_after, then succeeds", async () => {
        let n = 0;
        const api = new TelegramApi("T", async () => {
            n++;
            if (n === 1) return jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 0 } });
            return jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: "b" } });
        });
        await api.getMe();
        expect(n).toBe(2);
    });

    test("non-429 errors throw a TelegramApiError with the code", async () => {
        const api = new TelegramApi("T", async () =>
            jsonResponse({ ok: false, error_code: 401, description: "Unauthorized" }),
        );
        await expect(api.getMe()).rejects.toBeInstanceOf(TelegramApiError);
        try {
            await api.getMe();
        } catch (err) {
            expect((err as TelegramApiError).code).toBe(401);
        }
    });

    test("parse-entities and not-modified errors are classified", () => {
        expect(isParseError(new TelegramApiError("can't parse entities: bad tag"))).toBe(true);
        expect(isNotModifiedError(new TelegramApiError("message is not modified"))).toBe(true);
        expect(isParseError(new TelegramApiError("chat not found"))).toBe(false);
    });
});

// ---- render ----------------------------------------------------------------

describe("render", () => {
    test("escapes HTML metacharacters", () => {
        expect(escapeHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    });

    test("converts fences, inline code, bold/italic and links to Telegram HTML", () => {
        const [out] = markdownToTelegramChunks("**bold** and `x<y` see [docs](https://e.com)\n\n```js\na < b\n```");
        expect(out).toContain("<b>bold</b>");
        expect(out).toContain("<code>x&lt;y</code>");
        expect(out).toContain('<a href="https://e.com">docs</a>');
        expect(out).toContain('<pre><code class="language-js">a &lt; b</code></pre>');
    });

    test("splits oversized output into multiple within-limit chunks", () => {
        const big = Array.from({ length: 400 }, (_, i) => `line ${i} with some words here`).join("\n\n");
        const chunks = markdownToTelegramChunks(big);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_LIMIT);
    });

    test("a code block larger than the limit is split but stays fenced", () => {
        const code = "```\n" + Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n```";
        const chunks = markdownToTelegramChunks(code);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) {
            expect(c.startsWith("<pre><code")).toBe(true);
            expect(c.length).toBeLessThanOrEqual(CHUNK_LIMIT);
        }
    });

    test("renders a markdown table as an aligned pre block", () => {
        const [out] = markdownToTelegramChunks("| name | qty |\n|---|---|\n| apples | 3 |");
        expect(out).toContain("<pre>");
        expect(out).toContain("name");
        expect(out).toContain("apples");
        expect(out).not.toContain("|---|");
    });

    test("a table introduced by a lead-in line still renders as a table", () => {
        const [out] = markdownToTelegramChunks("Results:\n| a | b |\n|---|---|\n| 1 | 2 |");
        expect(out).toContain("Results:");
        expect(out).toContain("<pre>");
        // The raw pipe syntax must not survive.
        expect(out).not.toContain("| a | b |");
    });

    test("an oversized table splits without losing any row", () => {
        const rows = Array.from({ length: 300 }, (_, i) => `| row${i} | ${"v".repeat(20)} |`).join("\n");
        const chunks = markdownToTelegramChunks(`| name | value |\n|---|---|\n${rows}`);
        expect(chunks.length).toBeGreaterThan(1);
        const all = chunks.join("\n");
        for (let i = 0; i < 300; i++) expect(all).toContain(`row${i}`);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_LIMIT);
    });

    test("truncate guards tiny limits instead of returning nearly the whole string", () => {
        expect(truncate("hello", 0)).toBe("…");
        expect(truncate("hello", 1)).toBe("…");
        expect(truncate("hello", 2)).toBe("h…");
        expect(truncate("hi", 5)).toBe("hi");
    });

    test("htmlToPlain strips tags and restores entities", () => {
        expect(htmlToPlain("<b>hi</b> <code>a &lt; b</code>")).toBe("hi a < b");
    });

    test("toolLine uses verb grammar, not a shell prompt", () => {
        expect(toolLine("bash", { command: "bun test\nsecond line" })).toBe("Bash bun test");
        expect(toolLine("read", { path: "/a/b.ts" })).toBe("Read /a/b.ts");
        expect(toolLine("grep", { pattern: "foo" })).toBe("Grep foo");
        expect(toolLine("bash", {})).toBe("Bash");
    });

    test("formatCost and formatContext produce HTML pre blocks", () => {
        const cost = formatCost(
            { lifetimeUsd: 12.5, byProvider: { xai: 12.5 }, todayUsd: 1, last7Usd: 3, monthUsd: 5, cwdUsd: 2 },
            { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 0.1234 },
        );
        expect(cost).toContain("<pre>");
        expect(cost).toContain("session");
        const ctx = formatContext({
            modelId: "xai/grok-4",
            contextWindow: 1000,
            autoCompactThreshold: 0.8,
            categories: [{ key: "messages", label: "messages", tokens: 250 }],
            totalTokens: 250,
            freeTokens: 750,
            skills: [],
            toolCount: 3,
            mcpToolCount: 0,
        });
        expect(ctx).toContain("grok-4");
        // ASCII bar: Telegram's mobile code font substitutes box-drawing glyphs
        // from fallback fonts with mismatched widths, so the bar's drawn width
        // would change with how full it is.
        expect(ctx).toContain("#");
        expect(ctx).not.toContain("■");
    });

    test("cost amounts are right-aligned so the decimals form a column", () => {
        const cost = formatCost(
            { lifetimeUsd: 1234.5678, byProvider: {}, todayUsd: 12.34, last7Usd: 88.9, monthUsd: 310.25, cwdUsd: 0 },
            { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 0.4213 },
        );
        const lines = cost
            .replace(/<[^>]+>/g, "")
            .split("\n")
            .slice(1);
        const dollarColumns = new Set(lines.filter((l) => l.includes("$")).map((l) => l.indexOf("$")));
        // A ragged table has the $ starting at several different columns.
        expect(dollarColumns.size).toBeGreaterThan(0);
        expect([...dollarColumns].every((c) => c === [...dollarColumns][0])).toBe(false);
        // …but every amount must END at the same column.
        const ends = new Set(lines.filter((l) => l.includes("$")).map((l) => l.length));
        expect(ends.size).toBe(1);
    });

    test("the steak heatmap uses only ASCII, so no font can misalign its columns", () => {
        const weeks = 6;
        const cells = Array.from({ length: 7 }, (_, d) => Array.from({ length: weeks }, (_, w) => ((d + w) % 6) - 1));
        const out = formatSteak({
            totalTokens: 45_600_000,
            stats: { activeDays: 210, currentStreak: 12, longestStreak: 34 } as never,
            weeks,
            cells,
            tokens: cells,
            startDay: "2026-01-04",
            monthLabels: [],
        } as never);
        const grid = out.slice(out.indexOf("<pre>") + 5, out.indexOf("</pre>"));
        expect(grid).toMatch(/^[.:+#@\s]+$/);
        // Every row is the same width — the property ragged glyphs destroyed.
        const rows = grid.split("\n");
        expect(rows).toHaveLength(7);
        expect(new Set(rows.map((r) => r.length)).size).toBe(1);
    });
});

describe("menus", () => {
    test("settingsKeyboard renders one toggle button per row with state", () => {
        const kb = settingsKeyboard([{ key: "memory", label: "memory", value: true }]);
        expect(kb).toEqual([[{ text: "memory · on", callback_data: "set:memory" }]]);
    });

    test("modelKeyboard encodes an index, not the (too-long) model id", () => {
        const kb = modelKeyboard([{ id: "xai/grok-4-fast-reasoning-latest", provider: "xai" }], undefined);
        expect(kb[0][0].callback_data).toBe("mdl:0");
    });

    test("thinkingKeyboard marks the current level", () => {
        const kb = thinkingKeyboard(["off", "low", "high"], "low");
        const flat = kb.flat().map((b) => b.text);
        expect(flat).toContain("· low");
    });
});

// ---- bridge integration ----------------------------------------------------

interface FakeCall {
    method: string;
    params: Record<string, unknown>;
}

/** In-process jsonrpc peer with scriptable handlers + a notify() to simulate
 * turn events, exactly the transport RpcServer exposes to the bridge. */
class FakeRpc implements RpcAttachable {
    calls: FakeCall[] = [];
    handlers: Record<string, (p: Record<string, unknown>) => unknown> = {};
    private transport!: { send(msg: RpcResponse | RpcNotification): void };

    attach(transport: { send(msg: RpcResponse | RpcNotification): void }) {
        this.transport = transport;
        return {
            feed: (chunk: string) => {
                for (const line of chunk.split("\n")) {
                    const t = line.trim();
                    if (!t) continue;
                    const req = JSON.parse(t) as { id: number; method: string; params?: Record<string, unknown> };
                    this.calls.push({ method: req.method, params: req.params ?? {} });
                    Promise.resolve()
                        .then(() => this.handlers[req.method]?.(req.params ?? {}))
                        .then(
                            (result) => transport.send({ jsonrpc: "2.0", id: req.id, result }),
                            (err: Error) =>
                                transport.send({
                                    jsonrpc: "2.0",
                                    id: req.id,
                                    error: { code: -32603, message: err.message },
                                }),
                        );
                }
            },
            close: () => {},
        };
    }

    notify(method: string, params: unknown): void {
        this.transport.send({ jsonrpc: "2.0", method, params });
    }

    seen(method: string): FakeCall[] {
        return this.calls.filter((c) => c.method === method);
    }
}

interface Sent {
    kind: "send" | "edit" | "answer";
    chatId?: number;
    messageId?: number;
    text?: string;
    keyboard?: unknown;
}

class FakeApi implements TelegramApiLike {
    sent: Sent[] = [];
    private nextMessageId = 100;

    async getMe() {
        return { id: 1, is_bot: true, first_name: "bot", username: "mybot" };
    }
    async getUpdates() {
        return [] as TgUpdate[];
    }
    async sendMessage(opts: { chatId: number; text: string; keyboard?: unknown }) {
        const message_id = this.nextMessageId++;
        this.sent.push({
            kind: "send",
            chatId: opts.chatId,
            text: opts.text,
            keyboard: opts.keyboard,
            messageId: message_id,
        });
        return { message_id, chat: { id: opts.chatId, type: "private" } };
    }
    async editMessageText(opts: { chatId: number; messageId: number; text: string; keyboard?: unknown }) {
        this.sent.push({
            kind: "edit",
            chatId: opts.chatId,
            messageId: opts.messageId,
            text: opts.text,
            keyboard: opts.keyboard,
        });
    }
    async answerCallbackQuery(_id: string, text?: string) {
        this.sent.push({ kind: "answer", text });
    }
    async setMyCommands() {}
    async sendChatAction() {}
    async sendDocument() {}
    async getFileBase64() {
        return { data: "AAAA", size: 3 };
    }

    lastSend(): Sent | undefined {
        return [...this.sent].reverse().find((s) => s.kind === "send");
    }
    texts(): string[] {
        return this.sent.map((s) => s.text ?? "");
    }
}

function baseHandlers(rpc: FakeRpc): void {
    rpc.handlers["server.info"] = () => ({ defaults: { model: "xai/grok-4" } });
    rpc.handlers["session.create"] = () => ({ sessionId: "s1" });
    rpc.handlers["session.attach"] = () => ({ ok: true });
    rpc.handlers["session.detach"] = () => ({ ok: true });
    rpc.handlers["session.send"] = () => ({ ok: true });
    rpc.handlers["session.open"] = () => ({ ok: true });
    rpc.handlers["session.cancel"] = () => ({ ok: true });
    rpc.handlers["cost.session"] = () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 0 });
    rpc.handlers["auth.status"] = () => ({ providers: ["xai", "anthropic"], active: "xai" });
    rpc.handlers["session.history"] = () => ({ name: "demo", entries: [] });
}

function makeBridge(over: { chatId?: number; pairCode?: string } = {}) {
    const rpc = new FakeRpc();
    baseHandlers(rpc);
    const api = new FakeApi();
    const paired: number[] = [];
    const bridge = new TelegramBridge({
        api,
        rpc,
        chatId: over.chatId,
        pairCode: over.pairCode,
        cwd: "/tmp/x",
        onPaired: (id) => paired.push(id),
        log: () => {},
    });
    return { rpc, api, bridge, paired };
}

const message = (chatId: number, text: string, updateId = 1): TgUpdate => ({
    update_id: updateId,
    message: { message_id: updateId, chat: { id: chatId, type: "private" }, text },
});

const callback = (chatId: number, data: string, messageId = 100): TgUpdate => ({
    update_id: 1,
    callback_query: {
        id: "cb1",
        from: { id: chatId, is_bot: false, first_name: "u" },
        message: { message_id: messageId, chat: { id: chatId, type: "private" } },
        data,
    },
});

describe("TelegramBridge pairing + authorization", () => {
    test("rejects a message from a chat that isn't the paired one", async () => {
        const { api, bridge, rpc } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(999, "hello"));
        await flush();
        expect(api.texts().some((t) => /not authorized/i.test(t))).toBe(true);
        expect(rpc.seen("session.create").length).toBe(0);
    });

    test("/start with the right code pairs and persists the chat id", async () => {
        const { api, bridge, paired } = makeBridge({ pairCode: "abc123" });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/start abc123"));
        await flush();
        expect(paired).toEqual([42]);
        expect(api.texts().some((t) => /connected/i.test(t))).toBe(true);
    });

    test("/start with a wrong code does not pair", async () => {
        const { bridge, paired, api } = makeBridge({ pairCode: "abc123" });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/start nope"));
        await flush();
        expect(paired).toEqual([]);
        expect(api.texts().some((t) => /pairing link/i.test(t))).toBe(true);
    });

    test("bare /start (no code) explains the deep-link requirement without echoing the code", async () => {
        const { bridge, paired, api } = makeBridge({ pairCode: "abc123" });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/start"));
        await flush();
        expect(paired).toEqual([]);
        // Must never leak the real code to an unpaired sender.
        expect(api.texts().some((t) => t.includes("abc123"))).toBe(false);
        expect(api.texts().some((t) => /pairing link/i.test(t))).toBe(true);
    });

    test("once paired, a second chat's /start is refused", async () => {
        const { bridge, api } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(7, "/start whatever"));
        await flush();
        expect(api.texts().some((t) => /not authorized/i.test(t))).toBe(true);
    });
});

describe("TelegramBridge commands", () => {
    test("/cost calls cost.stats and replies with the breakdown", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["cost.stats"] = () => ({
            lifetimeUsd: 5,
            byProvider: { xai: 5 },
            todayUsd: 1,
            last7Usd: 2,
            monthUsd: 3,
            cwdUsd: 4,
        });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/cost"));
        await flush();
        expect(rpc.seen("cost.stats").length).toBe(1);
        expect(api.lastSend()?.text).toContain("lifetime");
    });

    test("/settings renders a keyboard, and a toggle callback writes settings.set", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        let memory = true;
        rpc.handlers["settings.list"] = () => [{ key: "memory", label: "memory", value: memory }];
        rpc.handlers["settings.set"] = (p) => {
            memory = p.value as boolean;
            return { key: p.key, value: p.value };
        };
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/settings"));
        await flush();
        expect(api.lastSend()?.keyboard).toEqual([[{ text: "memory · on", callback_data: "set:memory" }]]);

        await bridge.handleUpdate(callback(42, "set:memory"));
        await flush();
        const set = rpc.seen("settings.set");
        expect(set.length).toBe(1);
        expect(set[0].params.value).toBe(false);
    });

    test("/model → provider → model callback sets the model", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["catalog.list"] = (p) => {
            const all = [
                { id: "xai/grok-4", provider: "xai" },
                { id: "anthropic/claude", provider: "anthropic" },
            ];
            return p.provider ? all.filter((m) => m.provider === p.provider) : all;
        };
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/model"));
        await flush();
        // provider step
        expect(JSON.stringify(api.lastSend()?.keyboard)).toContain("prov:xai");

        await bridge.handleUpdate(callback(42, "prov:xai"));
        await flush();
        await bridge.handleUpdate(callback(42, "mdl:0"));
        await flush();
        expect(api.sent.some((s) => /model set: xai\/grok-4/.test(s.text ?? ""))).toBe(true);
    });

    test("unknown command is reported, not sent to the agent", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/wat"));
        await flush();
        expect(api.lastSend()?.text).toContain("unknown command");
        expect(rpc.seen("session.create").length).toBe(0);
    });
});

describe("TelegramBridge live turn", () => {
    test("a plain message runs a turn and sends the final text as its own message", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "hello agent"));
        await flush();
        expect(rpc.seen("session.create").length).toBe(1);
        expect(rpc.seen("session.send").length).toBe(1);

        rpc.notify("session.event", { sessionId: "s1", part: { type: "text-delta", data: "All done." } });
        rpc.notify("session.event", { sessionId: "s1", part: { type: "finish", data: {} } });
        await flush(6);

        expect(api.sent.some((s) => s.kind === "send" && (s.text ?? "").includes("All done."))).toBe(true);
    });

    test("each tool call is rendered as its own message, in order before the answer", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "run the tests"));
        await flush();

        rpc.notify("session.event", {
            sessionId: "s1",
            part: { type: "tool-call", data: { toolName: "bash", input: { command: "bun test" }, toolCallId: "t1" } },
        });
        rpc.notify("session.event", {
            sessionId: "s1",
            part: { type: "tool-call", data: { toolName: "read", input: { path: "/a/b.ts" }, toolCallId: "t2" } },
        });
        rpc.notify("session.event", { sessionId: "s1", part: { type: "text-delta", data: "Tests pass." } });
        rpc.notify("session.event", { sessionId: "s1", part: { type: "finish", data: {} } });
        await flush(8);

        const sends = api.sent.filter((s) => s.kind === "send").map((s) => s.text ?? "");
        expect(sends.some((t) => t.includes("<b>Bash</b>") && t.includes("bun test"))).toBe(true);
        expect(sends.some((t) => t.includes("<b>Read</b>") && t.includes("/a/b.ts"))).toBe(true);
        // The tool messages precede the final answer message.
        const bashIdx = sends.findIndex((t) => t.includes("bun test"));
        const answerIdx = sends.findIndex((t) => t.includes("Tests pass."));
        expect(bashIdx).toBeLessThan(answerIdx);
    });

    test("a failed tool edits its own message with the failure", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "do it"));
        await flush();

        rpc.notify("session.event", {
            sessionId: "s1",
            part: { type: "tool-call", data: { toolName: "bash", input: { command: "false" }, toolCallId: "t1" } },
        });
        await flush(3);
        const toolMsg = [...api.sent]
            .reverse()
            .find((s) => s.kind === "send" && (s.text ?? "").includes("<b>Bash</b>"));
        rpc.notify("session.event", {
            sessionId: "s1",
            part: { type: "tool-error", data: { toolCallId: "t1", toolName: "bash", error: "exit 1" } },
        });
        await flush(3);
        const edit = api.sent.find((s) => s.kind === "edit" && s.messageId === toolMsg?.messageId);
        expect(edit?.text).toContain("failed");
        expect(edit?.text).toContain("exit 1");
    });

    test("a plain message mid-turn interrupts and then runs", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "first"));
        await flush();
        await bridge.handleUpdate(message(42, "second", 2));
        await flush(4);
        // The running turn was cancelled and the user told what happened.
        expect(rpc.seen("session.cancel").length).toBe(1);
        expect(api.texts().some((t) => /interrupting/i.test(t))).toBe(true);
        // The cancel surfaces as the turn's error; the new prompt then runs.
        rpc.notify("session.event", { sessionId: "s1", part: { type: "error", data: "aborted" } });
        await flush(8);
        const sends = rpc.seen("session.send");
        expect(sends.length).toBe(2);
        expect(sends[1].params.input).toBe("second");
        // An interrupt's abort isn't reported as a turn error.
        expect(api.texts().some((t) => /error: aborted/i.test(t))).toBe(false);
    });

    test("interrupts preserve the order they were sent", async () => {
        const { rpc, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "first"));
        await flush();
        await bridge.handleUpdate(message(42, "A", 2));
        await flush(2);
        await bridge.handleUpdate(message(42, "B", 3));
        await flush(2);
        // Only one cancel — the second interrupt joins the queue behind the first.
        expect(rpc.seen("session.cancel").length).toBe(1);
        rpc.notify("session.event", { sessionId: "s1", part: { type: "error", data: "aborted" } });
        await flush(8);
        rpc.notify("session.event", { sessionId: "s1", part: { type: "finish", data: {} } });
        await flush(8);
        const inputs = rpc.seen("session.send").map((c) => c.params.input);
        expect(inputs).toEqual(["first", "A", "B"]);
    });

    test("/queue waits for the turn instead of interrupting, then runs", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "working on it"));
        await flush();
        await bridge.handleUpdate(message(42, "/queue do this after", 2));
        await flush(2);
        // No interruption: the running turn is untouched.
        expect(rpc.seen("session.cancel").length).toBe(0);
        expect(api.texts().some((t) => /queued \(position 1\)/i.test(t))).toBe(true);
        rpc.notify("session.event", { sessionId: "s1", part: { type: "finish", data: {} } });
        await flush(10);
        const inputs = rpc.seen("session.send").map((c) => c.params.input);
        expect(inputs).toEqual(["working on it", "do this after"]);
    });

    test("a plain message jumps ahead of an explicitly queued one", async () => {
        const { rpc, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "running"));
        await flush();
        await bridge.handleUpdate(message(42, "/queue later", 2));
        await flush(2);
        await bridge.handleUpdate(message(42, "urgent", 3));
        await flush(2);
        rpc.notify("session.event", { sessionId: "s1", part: { type: "error", data: "aborted" } });
        await flush(8);
        rpc.notify("session.event", { sessionId: "s1", part: { type: "finish", data: {} } });
        await flush(8);
        const inputs = rpc.seen("session.send").map((c) => c.params.input);
        expect(inputs).toEqual(["running", "urgent", "later"]);
    });

    test("/cancel drops the queue so nothing runs afterwards", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "running"));
        await flush();
        await bridge.handleUpdate(message(42, "/queue later", 2));
        await flush(2);
        await bridge.handleUpdate(message(42, "/cancel", 3));
        await flush(2);
        expect(api.texts().some((t) => /dropped 1 queued/i.test(t))).toBe(true);
        rpc.notify("session.event", { sessionId: "s1", part: { type: "error", data: "aborted" } });
        await flush(8);
        expect(rpc.seen("session.send").length).toBe(1);
    });

    test("/queue with nothing running starts it immediately", async () => {
        const { rpc, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/queue go now"));
        await flush(6);
        const inputs = rpc.seen("session.send").map((c) => c.params.input);
        expect(inputs).toEqual(["go now"]);
    });

    test("/queue lists and clears", async () => {
        const { api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "running"));
        await flush();
        await bridge.handleUpdate(message(42, "/queue one", 2));
        await flush(2);
        await bridge.handleUpdate(message(42, "/queue", 3));
        await flush(2);
        expect(api.lastSend()?.text).toContain("one");
        await bridge.handleUpdate(message(42, "/queue clear", 4));
        await flush(2);
        expect(api.lastSend()?.text).toMatch(/cleared/i);
    });

    test("/new cancels the turn still running on the session it abandons", async () => {
        const { rpc, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "long job"));
        await flush();
        await bridge.handleUpdate(message(42, "/new", 2));
        await flush(4);
        // Left running, the old turn would keep burning tokens with its output
        // going nowhere (its events are dropped once sessionId changes).
        expect(rpc.seen("session.cancel").length).toBe(1);
        expect(rpc.seen("session.cancel")[0].params.sessionId).toBe("s1");
        // And the slot is free: the next message starts a brand-new session.
        await bridge.handleUpdate(message(42, "fresh start", 3));
        await flush(4);
        expect(rpc.seen("session.create").length).toBe(2);
    });

    test("switching sessions cancels the turn on the one being left", async () => {
        const { rpc, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "long job"));
        await flush();
        await bridge.handleUpdate(callback(42, "ses:s2"));
        await flush(4);
        expect(rpc.seen("session.cancel").map((c) => c.params.sessionId)).toEqual(["s1"]);
    });

    test("a queued prompt that fails to start is reported in chat, and the rest still drain", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "running"));
        await flush();
        await bridge.handleUpdate(message(42, "/queue boom", 2));
        await bridge.handleUpdate(message(42, "/queue after", 3));
        await flush(2);
        // The first queued prompt's send fails; the second must still run.
        rpc.handlers["session.send"] = (p) => {
            if (p.input === "boom") throw new Error("model unavailable");
            return { ok: true };
        };
        rpc.notify("session.event", { sessionId: "s1", part: { type: "finish", data: {} } });
        await flush(10);
        expect(api.texts().some((t) => /queued message failed to start.*model unavailable/i.test(t))).toBe(true);
        expect(rpc.seen("session.send").map((c) => c.params.input)).toEqual(["running", "boom", "after"]);
    });

    test("after a turn finishes, the next message starts a fresh turn", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "one"));
        await flush();
        rpc.notify("session.event", { sessionId: "s1", part: { type: "text-delta", data: "done one" } });
        rpc.notify("session.event", { sessionId: "s1", part: { type: "finish", data: {} } });
        await flush(8);
        await bridge.handleUpdate(message(42, "two", 2));
        await flush();
        // The second message ran (not clobbered / not refused).
        expect(rpc.seen("session.send").length).toBe(2);
        expect(api.texts().some((t) => /already running/i.test(t))).toBe(false);
    });

    test("tokens arriving immediately after session.send are not dropped", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        // Emit a token from inside the session.send handler — i.e. the instant
        // the server accepts, before its response is even delivered.
        rpc.handlers["session.send"] = () => {
            rpc.notify("session.event", { sessionId: "s1", part: { type: "text-delta", data: "FIRST-TOKEN " } });
            return { ok: true };
        };
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "go"));
        await flush(6);
        rpc.notify("session.event", { sessionId: "s1", part: { type: "finish", data: {} } });
        await flush(8);
        expect(api.sent.some((s) => (s.text ?? "").includes("FIRST-TOKEN"))).toBe(true);
    });

    test("a failed session.send releases the turn slot", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["session.send"] = () => {
            throw new Error("model exploded");
        };
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "go"));
        await flush(4);
        // The next message must run, not be refused as "already running".
        rpc.handlers["session.send"] = () => ({ ok: true });
        await bridge.handleUpdate(message(42, "again", 2));
        await flush(4);
        expect(api.texts().some((t) => /already running/i.test(t))).toBe(false);
        expect(rpc.seen("session.send").length).toBe(2);
    });

    test("leading whitespace tokens don't create an empty message", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "go"));
        await flush();
        rpc.notify("session.event", { sessionId: "s1", part: { type: "text-delta", data: "  \n " } });
        await flush(4);
        // Nothing sent yet beyond (possibly) nothing at all — no blank bubble.
        expect(api.sent.filter((s) => s.kind === "send").length).toBe(0);
        rpc.notify("session.event", { sessionId: "s1", part: { type: "text-delta", data: "real content" } });
        rpc.notify("session.event", { sessionId: "s1", part: { type: "finish", data: {} } });
        await flush(8);
        expect(api.sent.some((s) => (s.text ?? "").includes("real content"))).toBe(true);
        expect(api.texts().some((t) => t.trim() === "…")).toBe(false);
    });

    test("a long answer rolls across messages, each rendered (escaped), not raw", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "go"));
        await flush();
        // ~4800 chars with a metacharacter, forcing at least one roll (>3500).
        const big = "x < y ".repeat(800);
        rpc.notify("session.event", { sessionId: "s1", part: { type: "text-delta", data: big } });
        rpc.notify("session.event", { sessionId: "s1", part: { type: "finish", data: {} } });
        await flush(12);
        const bodies = api.sent.filter((s) => (s.text ?? "").includes("y")).map((s) => s.text ?? "");
        // Rolled into more than one message.
        expect(bodies.length).toBeGreaterThan(1);
        // The metacharacter is escaped everywhere, and no raw "x < y" survives.
        const all = api.sent.map((s) => s.text ?? "").join("\n");
        expect(all).toContain("&lt;");
        expect(all).not.toContain("x < y");
    });
});

describe("TelegramBridge model auth filtering", () => {
    test("/model only offers providers that are logged in", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["auth.status"] = () => ({ providers: ["xai"], active: "xai" });
        rpc.handlers["catalog.list"] = (p) => {
            const all = [
                { id: "xai/grok-4", provider: "xai", available: true },
                { id: "anthropic/claude", provider: "anthropic", available: true },
            ];
            return p.provider ? all.filter((m) => m.provider === p.provider) : all;
        };
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/model"));
        await flush();
        const kb = JSON.stringify(api.lastSend()?.keyboard);
        expect(kb).toContain("prov:xai");
        expect(kb).not.toContain("prov:anthropic");
    });

    test("/model with no logged-in providers tells the user to log in", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["auth.status"] = () => ({ providers: [], active: null });
        rpc.handlers["catalog.list"] = () => [{ id: "xai/grok-4", provider: "xai", available: true }];
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/model"));
        await flush();
        expect(api.lastSend()?.text).toMatch(/no providers are logged in/i);
    });

    // auth.status `providers` is the USABLE set, not the logged-in set: ollama
    // and bedrock need no login and custom gateways are stored separately, so
    // none of them have an auth entry. Filtering on logged-in dropped every one
    // of their models from /model with no error to explain the absence.
    test("/model offers zero-login and custom-gateway providers, which have no auth entry", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["auth.status"] = () => ({
            providers: ["xai", "ollama", "custom:bifrost"],
            authorized: ["xai"], // only xai has stored credentials
            active: "xai",
        });
        rpc.handlers["catalog.list"] = (p) => {
            const all = [
                { id: "xai/grok-4", provider: "xai", available: true },
                { id: "ollama/llama3", provider: "ollama", available: true },
                { id: "custom:bifrost/opus", provider: "custom:bifrost", available: true },
                { id: "anthropic/claude", provider: "anthropic", available: true },
            ];
            return p.provider ? all.filter((m) => m.provider === p.provider) : all;
        };
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/model"));
        await flush();
        const kb = JSON.stringify(api.lastSend()?.keyboard);
        expect(kb).toContain("prov:ollama");
        expect(kb).toContain("prov:custom:bifrost");
        expect(kb).toContain("prov:xai");
        // Still filtered — a provider that is neither usable nor logged in.
        expect(kb).not.toContain("prov:anthropic");
    });
});

describe("TelegramBridge session pagination", () => {
    const manySessions = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
            id: `s${i}`,
            name: `session ${i}`,
            mtime: n - i, // s0 newest
            running: false,
            firstUserMessage: "",
        }));

    test("a long session list is paged, not truncated", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["session.list"] = () => manySessions(20);
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/sessions"));
        await flush();
        const kb = JSON.stringify(api.lastSend()?.keyboard);
        // First page: newest 8, plus a nav row — the 9th newest must not be on it.
        expect(kb).toContain("ses:s0");
        expect(kb).toContain("ses:s7");
        expect(kb).not.toContain("ses:s8");
        expect(kb).toContain("sesp:1");
        expect(api.lastSend()?.text).toContain("20 total");
    });

    test("next turns the page in place, reaching sessions the old list cut off", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["session.list"] = () => manySessions(20);
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/sessions"));
        await flush();
        const menuId = api.lastSend()?.messageId ?? 100;
        await bridge.handleUpdate(callback(42, "sesp:1", menuId));
        await flush();
        const edit = [...api.sent].reverse().find((s) => s.kind === "edit");
        const kb = JSON.stringify(edit?.keyboard);
        // s8..s15 — the range the old hard `.slice(0, 10)` could never show.
        expect(kb).toContain("ses:s8");
        expect(kb).toContain("ses:s15");
        expect(kb).not.toContain("ses:s7");
        expect(kb).toContain("2/3");
    });

    test("prev from the first page wraps to the last", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["session.list"] = () => manySessions(20);
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/sessions"));
        await flush();
        const kb = JSON.stringify(api.lastSend()?.keyboard);
        expect(kb).toContain("sesp:2"); // prev from page 0 of 3
    });

    test("a page number past the end clamps instead of showing an empty menu", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        // Menu drawn when there were many; sessions deleted since.
        rpc.handlers["session.list"] = () => manySessions(3);
        await bridge.startAndValidate();
        await bridge.handleUpdate(callback(42, "sesp:9", 100));
        await flush();
        const edit = [...api.sent].reverse().find((s) => s.kind === "edit");
        expect(JSON.stringify(edit?.keyboard)).toContain("ses:s0");
    });

    test("one page of sessions gets no nav row", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["session.list"] = () => manySessions(3);
        await bridge.startAndValidate();
        await bridge.handleUpdate(message(42, "/sessions"));
        await flush();
        expect(JSON.stringify(api.lastSend()?.keyboard)).not.toContain("sesp:");
    });
});

describe("TelegramBridge session replay", () => {
    test("switching to a session replays its recent transcript", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["session.history"] = () => ({
            name: "my chat",
            entries: [
                { type: "message", role: "user", content: "hi there" },
                { type: "message", role: "assistant", content: [{ type: "text", text: "hello back" }] },
            ],
        });
        await bridge.startAndValidate();
        await bridge.handleUpdate(callback(42, "ses:s9"));
        await flush(4);
        expect(rpc.seen("session.open").length).toBe(1);
        const sends = api.sent.filter((s) => s.kind === "send").map((s) => s.text ?? "");
        expect(sends.some((t) => /resumed/i.test(t) && t.includes("my chat"))).toBe(true);
        expect(sends.some((t) => t.includes("hi there"))).toBe(true);
        expect(sends.some((t) => t.includes("hello back"))).toBe(true);
    });

    // A replay used to be one message per turn — a dozen phone notifications
    // for one action, with the chat buried under them.
    test("a replay arrives as ONE message, not one per turn", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        rpc.handlers["session.history"] = () => ({
            name: "my chat",
            entries: Array.from({ length: 10 }, (_, i) => [
                { type: "message", role: "user", content: `question ${i}` },
                { type: "message", role: "assistant", content: [{ type: "text", text: `answer ${i}` }] },
            ]).flat(),
        });
        await bridge.startAndValidate();
        await bridge.handleUpdate(callback(42, "ses:s9"));
        await flush(6);
        const sends = api.sent.filter((s) => s.kind === "send");
        expect(sends).toHaveLength(1);
        const text = sends[0].text ?? "";
        // …and it still carries the header and every replayed turn.
        expect(text).toContain("resumed");
        expect(text).toContain("my chat");
        expect(text).toContain("answer 9");
        expect(text).toContain("question 4");
    });

    test("an over-long replay splits between turns, never mid-entry", async () => {
        const { rpc, api, bridge } = makeBridge({ chatId: 42 });
        const big = "x".repeat(1100);
        rpc.handlers["session.history"] = () => ({
            name: "long",
            entries: Array.from({ length: 12 }, (_, i) => ({
                type: "message",
                role: "user",
                content: `${i}-${big}`,
            })),
        });
        await bridge.startAndValidate();
        await bridge.handleUpdate(callback(42, "ses:s9"));
        await flush(8);
        const sends = api.sent.filter((s) => s.kind === "send").map((s) => s.text ?? "");
        expect(sends.length).toBeGreaterThan(1); // too big for one
        for (const t of sends) {
            expect(t.length).toBeLessThanOrEqual(3900);
            // Splitting inside an entry would orphan a <b> tag and Telegram
            // would reject the message outright.
            const open = (t.match(/<b>/g) ?? []).length;
            const close = (t.match(/<\/b>/g) ?? []).length;
            expect(open).toBe(close);
        }
    });
});
