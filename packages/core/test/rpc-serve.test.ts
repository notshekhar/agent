import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempSessionDb } from "./helpers/temp-db";

// In-memory token store so tests never touch the real ~/.loop/auth.json.
let storedToken: string | undefined;
mock.module("../src/rpc/serve-token-store", () => ({
    getStoredServeToken: () => storedToken,
    storeServeToken: (t: string) => {
        storedToken = t;
    },
}));

// In-memory settings so settings.set never writes the real ~/.loop/settings.json
// (same pattern as bash-approve.test.ts).
const memSettings: Record<string, unknown> = {};
mock.module("../src/settings", () => ({
    getSetting: (k: string) => memSettings[k],
    setSetting: (k: string, v: unknown) => {
        memSettings[k] = v;
    },
}));

const { getOrCreateServeToken, isLoopbackHost, startWebServer } = await import("../src/rpc/serve");
const { writeAttachmentPayloads, RpcServer } = await import("../src/rpc/server");
import type { ServeHandle } from "../src/rpc/serve";

/** In-memory transport for driving an RpcServer directly. */
function fakeTransport() {
    const sent: Array<Record<string, unknown>> = [];
    return {
        sent,
        send(msg: unknown) {
            sent.push(msg as Record<string, unknown>);
        },
        /** Responses to a given request id. */
        response(id: number) {
            return sent.find((m) => m.id === id);
        },
        /** All session.event notification params. */
        events() {
            return sent
                .filter((m) => m.method === "session.event")
                .map((m) => m.params as { sessionId: string; seq: number; part: { type: string; data: unknown } });
        },
    };
}

/** Unknown-provider sends fail at getModel; keep budget for init under CI load. */
async function until(cond: () => boolean, label: string, tries = 1000, ms = 10): Promise<void> {
    for (let i = 0; i < tries; i++) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, ms));
    }
    // Name the starved wait — the async stack loses the call site, and an
    // unlabeled "condition not met" cost a week of red ci (see issue #3).
    throw new Error(`until: condition not met: ${label}`);
}

describe("serve token", () => {
    test("generated once, then stable across calls", () => {
        storedToken = undefined;
        const first = getOrCreateServeToken();
        expect(first).toMatch(/^[0-9a-f]{48}$/);
        expect(getOrCreateServeToken()).toBe(first);
    });

    test("existing stored token is reused, not replaced", () => {
        storedToken = "a".repeat(48);
        expect(getOrCreateServeToken()).toBe(storedToken);
    });
});

describe("isLoopbackHost", () => {
    test("loopback names", () => {
        expect(isLoopbackHost("127.0.0.1")).toBe(true);
        expect(isLoopbackHost("::1")).toBe(true);
        expect(isLoopbackHost("localhost")).toBe(true);
        expect(isLoopbackHost("0.0.0.0")).toBe(false);
        expect(isLoopbackHost("192.168.1.4")).toBe(false);
    });
});

describe("writeAttachmentPayloads", () => {
    // 1x1 transparent PNG
    const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const PDF_B64 = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");

    test("writes temp files and returns [image:] sentinels", async () => {
        const out = writeAttachmentPayloads([{ data: PNG_B64, mediaType: "image/png" }]);
        const m = out.match(/^\n\[image:(.+\.png)\]$/);
        expect(m).not.toBeNull();
        const file = Bun.file(m![1]!);
        expect(await file.exists()).toBe(true);
        expect(file.size).toBeGreaterThan(0);
    });

    test("takes PDFs too — extractImagesFromInput has always read .pdf sentinels", async () => {
        // Whether the chosen model may actually receive it is runTurn's call
        // (filterAttachmentsByModalities), not this function's: refusing here
        // meant no GUI client could attach a PDF to ANY model.
        const out = writeAttachmentPayloads([{ data: PDF_B64, mediaType: "application/pdf" }]);
        const m = out.match(/^\n\[image:(.+\.pdf)\]$/);
        expect(m).not.toBeNull();
        expect(await Bun.file(m![1]!).exists()).toBe(true);
    });

    test("rejects unknown media types, junk, and empty payloads", () => {
        expect(writeAttachmentPayloads(undefined)).toBe("");
        expect(writeAttachmentPayloads([])).toBe("");
        expect(writeAttachmentPayloads([{ data: PNG_B64, mediaType: "text/plain" }])).toBe("");
        expect(writeAttachmentPayloads([{ data: 42, mediaType: "image/png" }])).toBe("");
        expect(writeAttachmentPayloads([{ data: "", mediaType: "image/png" }])).toBe("");
    });
});

describe("multi-client broadcast + seq replay", () => {
    useTempSessionDb();

    test("events broadcast to every subscriber; attach replays; detach stops delivery", async () => {
        const server = new RpcServer();
        const a = fakeTransport();
        const b = fakeTransport();
        const c = fakeTransport();
        const fa = server.attach(a);
        const fb = server.attach(b);
        const fc = server.attach(c);
        // Real writable cwd — "/tmp" alone can fail create on some runners /
        // sandboxes and leaves response(1) undefined.
        const cwd = mkdtempSync(join(tmpdir(), "loop-rpc-"));

        // a creates (auto-subscribed); b attaches explicitly.
        fa.feed(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "session.create",
                params: { cwd, provider: "nope", model: "nope/model" },
            }) + "\n",
        );
        await until(() => !!a.response(1), "session.create response");
        const sid = (a.response(1) as { result: { sessionId: string } }).result.sessionId;
        fb.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.attach", params: { sessionId: sid } }) + "\n");
        await until(() => !!b.response(1), "session.attach response (b)");
        expect((b.response(1) as { result: { running: boolean } }).result.running).toBe(false);

        // session.list reflects both watchers, and re-opening from b does NOT
        // reset the shared context (attached count survives).
        fb.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.open", params: { sessionId: sid } }) + "\n");
        fb.feed(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session.list", params: {} }) + "\n");
        await until(() => !!b.response(3), "session.list response");
        const listed = (b.response(3) as { result: Array<{ id: string; attached: number; running: boolean }> }).result;
        expect(listed.find((s) => s.id === sid)?.attached).toBe(2);

        // A send on a bogus provider fails at getModel — the error event must
        // reach BOTH subscribers, with a seq stamp. Wait for the error on both
        // (fixed settle windows raced under load and saw mid-turn deltas first).
        fa.feed(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.send", params: { sessionId: sid, input: "hi" } }) +
                "\n",
        );
        await until(
            () => a.events().some((e) => e.part.type === "error") && b.events().some((e) => e.part.type === "error"),
            "error event broadcast to a AND b",
        );
        const aEvents = a.events();
        const bEvents = b.events();
        expect(aEvents.length).toBeGreaterThan(0);
        expect(bEvents.length).toBe(aEvents.length);
        expect(aEvents.some((e) => e.part.type === "error")).toBe(true);
        expect(bEvents.some((e) => e.part.type === "error")).toBe(true);
        expect(aEvents[0]!.seq).toBe(1);
        const total = aEvents.length;

        // c attaches with afterSeq 0 → full replay of the ring.
        fc.feed(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "session.attach",
                params: { sessionId: sid, afterSeq: 0 },
            }) + "\n",
        );
        await until(() => !!c.response(1) && c.events().length === total, "attach replay to c");
        expect(c.events().length).toBe(total);
        expect((c.response(1) as { result: { resync: boolean; seq: number } }).result).toMatchObject({
            resync: false,
            seq: total,
        });

        // afterSeq beyond the server's counter (client from a previous server
        // life) → resync, no replay.
        const d = fakeTransport();
        const fd = server.attach(d);
        fd.feed(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "session.attach",
                params: { sessionId: sid, afterSeq: 9999 },
            }) + "\n",
        );
        await until(() => !!d.response(1), "session.attach response (d, resync)");
        expect((d.response(1) as { result: { resync: boolean } }).result.resync).toBe(true);
        expect(d.events().length).toBe(0);

        // b detaches (transport close); the next failing send reaches a but not b.
        fb.close();
        const aBefore = a.events().length;
        const bBefore = b.events().length;
        fa.feed(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "session.send",
                params: { sessionId: sid, input: "again" },
            }) + "\n",
        );
        await until(() => a.events().length > aBefore, "post-detach error broadcast to a");
        expect(a.events().length).toBeGreaterThan(aBefore);
        expect(b.events().length).toBe(bBefore);
        // Real runTurn spins up a session + fails on the bogus provider; ~240ms
        // locally but a loaded CI runner blows past the 5s default. Give it room.
    }, 30000);
});

describe("startWebServer", () => {
    useTempSessionDb();

    let handle: ServeHandle;
    let token: string;
    const base = () => `http://127.0.0.1:${handle.port}`;

    beforeAll(() => {
        storedToken = undefined;
        // port 0 = OS-assigned free port; keeps parallel test runs collision-free.
        handle = startWebServer({ port: 0 });
        token = getOrCreateServeToken();
    });
    afterAll(() => {
        handle.stop();
    });

    test("reports the bound port and a token URL", () => {
        expect(handle.port).toBeGreaterThan(0);
        expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/?token=${token}`);
        // Loopback bind has no network face — no LAN URLs to advertise.
        expect(handle.networkUrls).toEqual([]);
    });

    test("session deep links serve the app (reload lands on the SPA)", async () => {
        const ok = await fetch(base() + `/session/abc123DEF?token=${token}`);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toContain("<title>loop</title>");
        // Token still required on deep links; malformed ids stay 404.
        expect((await fetch(base() + "/session/abc123DEF")).status).toBe(401);
        expect((await fetch(base() + `/session/abc-123!?token=${token}`)).status).toBe(404);
        expect((await fetch(base() + `/session/?token=${token}`)).status).toBe(404);
    });

    test("page requires the token", async () => {
        const noToken = await fetch(base() + "/");
        expect(noToken.status).toBe(401);
        const badToken = await fetch(base() + "/?token=wrong");
        expect(badToken.status).toBe(401);
        const ok = await fetch(base() + `/?token=${token}`);
        expect(ok.status).toBe(200);
        expect(ok.headers.get("content-type")).toContain("text/html");
        const html = await ok.text();
        expect(html).toContain("<title>loop</title>");
        // The page must never embed the token — it arrives via the URL.
        expect(html).not.toContain(token);
    });

    test("unknown paths 404 (with token), and the WS upgrade rejects bad tokens", async () => {
        expect((await fetch(base() + `/nope?token=${token}`)).status).toBe(404);
        expect((await fetch(base() + "/ws?token=wrong")).status).toBe(401);
    });

    test("usage.steak, cost.stats, settings over WS", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=${token}`);
        const next = () =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
                ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as Record<string, unknown>);
                ws.onerror = () => reject(new Error("ws error"));
            });
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("ws failed to open"));
        });
        const call = async (id: number, method: string, params?: unknown) => {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            return next();
        };

        const steak = (await call(1, "usage.steak")).result as {
            weeks: number;
            cells: number[][];
            tokens: number[][];
            startDay: string;
            monthLabels: string[];
            totalTokens: number;
        };
        expect(steak.weeks).toBeGreaterThan(50);
        expect(steak.cells.length).toBe(7);
        expect(steak.cells[0]!.length).toBe(steak.weeks);
        expect(steak.monthLabels.length).toBe(steak.weeks);
        // Raw per-day tokens + grid origin, for client tooltips/streaks.
        expect(steak.tokens.length).toBe(7);
        expect(steak.tokens[0]!.length).toBe(steak.weeks);
        expect(steak.startDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        const stats = (await call(2, "cost.stats", { cwd: "/nowhere" })).result as Record<string, unknown>;
        for (const k of ["lifetimeUsd", "todayUsd", "last7Usd", "monthUsd", "cwdUsd"]) {
            expect(typeof stats[k]).toBe("number");
        }

        const list = (await call(3, "settings.list")).result as Array<{ key: string; value: boolean }>;
        expect(list.length).toBeGreaterThan(5);
        const memory = list.find((s) => s.key === "memory");
        expect(memory?.value).toBe(true); // default, nothing set in mem store

        const set = await call(4, "settings.set", { key: "memory", value: false });
        expect((set.result as { value: boolean }).value).toBe(false);
        expect(memSettings.memory).toBe(false);
        const after = (await call(5, "settings.list")).result as Array<{ key: string; value: boolean }>;
        expect(after.find((s) => s.key === "memory")?.value).toBe(false);

        // Only allowlisted keys are writable; value must be boolean.
        const bad = await call(6, "settings.set", { key: "hooks", value: true });
        expect(bad.error).toBeDefined();
        const badVal = await call(7, "settings.set", { key: "memory", value: "yes" });
        expect(badVal.error).toBeDefined();

        ws.close();
    });

    test("extension.list + context.report over WS", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=${token}`);
        const next = () =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
                ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as Record<string, unknown>);
                ws.onerror = () => reject(new Error("ws error"));
            });
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("ws failed to open"));
        });
        const call = async (id: number, method: string, params?: unknown) => {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            return next();
        };

        // Built-ins always exist, so the list is never empty.
        const exts = (await call(1, "extension.list")).result as Array<{
            name: string;
            enabled: boolean;
            builtin: boolean;
        }>;
        expect(exts.length).toBeGreaterThan(0);
        for (const e of exts) {
            expect(typeof e.name).toBe("string");
            expect(typeof e.enabled).toBe("boolean");
            expect(typeof e.builtin).toBe("boolean");
        }

        // setEnabled validates its inputs before touching any state.
        const unknown = await call(2, "extension.setEnabled", { name: "no-such-extension", value: true });
        expect(unknown.error).toBeDefined();
        const badVal = await call(3, "extension.setEnabled", { name: exts[0]!.name, value: "on" });
        expect(badVal.error).toBeDefined();

        // Draft form (no session): fixed overhead for a cwd + model.
        const report = (await call(4, "context.report", { cwd: "/tmp", model: "nope/model" })).result as {
            categories: Array<{ key: string; tokens: number }>;
            totalTokens: number;
            freeTokens: number;
        };
        expect(Array.isArray(report.categories)).toBe(true);
        expect(report.categories.some((c) => c.key === "systemPrompt")).toBe(true);
        expect(report.totalTokens).toBeGreaterThan(0);

        ws.close();
    });

    test("WS speaks JSON-RPC: server.info handshake + session.list", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=${token}`);
        const next = () =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
                ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as Record<string, unknown>);
                ws.onerror = () => reject(new Error("ws error"));
                ws.onclose = () => reject(new Error("ws closed"));
            });
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("ws failed to open"));
        });

        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server.info" }));
        const info = await next();
        expect(info.id).toBe(1);
        const result = info.result as { methods: string[]; events: string[]; defaults: { cwd: string } };
        expect(result.methods).toContain("session.send");
        expect(result.events).toContain("text-delta");
        expect(typeof result.defaults.cwd).toBe("string");

        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.list" }));
        const list = await next();
        expect(list.id).toBe(2);
        expect(Array.isArray(list.result)).toBe(true);

        // create -> rename -> history reflects the new name
        ws.send(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "session.create",
                params: { cwd: "/tmp", model: "xai/test", provider: "xai" },
            }),
        );
        const created = (await next()) as { result: { sessionId: string } };
        const sid = created.result.sessionId;
        ws.send(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 4,
                method: "session.rename",
                params: { sessionId: sid, name: "my web session" },
            }),
        );
        const renamed = await next();
        expect((renamed as { result: { name: string } }).result.name).toBe("my web session");
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "session.history", params: { sessionId: sid } }));
        const hist = (await next()) as { result: { name?: string } };
        expect(hist.result.name).toBe("my web session");

        ws.close();
    });
});
