import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { Session } from "../src/sessions";
import { adaptSessionEntry } from "../src/sessions/session-adapter";
import type { StepTiming } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

// See reopen-persistence.test.ts for why the providers mock is file-wide.
let currentModel: MockLanguageModelV3 | null = null;
const realProviders = await import("../src/providers");
mock.module("../src/providers", () => ({
    ...realProviders,
    getModel: async (...args: Parameters<typeof realProviders.getModel>) =>
        currentModel ?? realProviders.getModel(...args),
}));

const MODEL = "anthropic/claude-sonnet-4-6";

function streamOf(events: any[], gapMs = 2) {
    let i = 0;
    return {
        stream: new ReadableStream({
            async pull(controller) {
                await new Promise((r) => setTimeout(r, gapMs));
                if (i < events.length) controller.enqueue(events[i++]);
                else controller.close();
            },
        }),
    };
}

function mkSession(dir: string) {
    const info = { id: "t", createdAt: 0, cwd: dir, provider: "anthropic" as const, model: MODEL };
    return { info, session: new Session(info, join(dir, "s.jsonl"), []) };
}

const assistantEntries = (s: Session) =>
    (s.entries() as any[]).filter((e) => e.type === "message" && e.role === "assistant");

describe("step timing is recorded on the step's assistant entry", () => {
    afterEach(() => {
        currentModel = null;
        mock.restore();
    });

    test("a tool step records the model bar, the tool bars and the step's end", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-timing-"));
        const { info, session } = mkSession(dir);

        let call = 0;
        currentModel = new MockLanguageModelV3({
            doStream: async () => {
                call++;
                if (call === 1) {
                    return streamOf([
                        { type: "tool-call", toolCallId: "c1", toolName: "ls", input: JSON.stringify({}) },
                        { type: "tool-call", toolCallId: "c2", toolName: "ls", input: JSON.stringify({ path: "." }) },
                        {
                            type: "finish",
                            finishReason: { unified: "tool-calls", raw: "tool_use" },
                            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                        },
                    ]);
                }
                return streamOf([
                    { type: "text-start", id: "t1" },
                    ..."done.".split("").map((c) => ({ type: "text-delta", id: "t1", delta: c })),
                    { type: "text-end", id: "t1" },
                    {
                        type: "finish",
                        finishReason: { unified: "stop", raw: "end_turn" },
                        usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 },
                    },
                ]);
            },
        });
        const { runTurn, CostTracker } = await import("../src/agent");

        const before = Date.now();
        await runTurn({
            session,
            modelId: MODEL,
            userInput: "list the project",
            cwd: dir,
            tracker: new CostTracker(),
            emitter: new EventEmitter() as any,
        });
        const after = Date.now();
        expect(call).toBe(2);

        // Read back through the disk path — the adapter must round-trip it.
        const reloaded = Session.load(join(dir, "s.jsonl"), info);
        const [toolStep, finalStep] = assistantEntries(reloaded);

        const t1 = toolStep.timing as StepTiming;
        expect(t1).toBeDefined();
        // Integer epoch ms, inside the turn, in order.
        for (const v of [t1.startedAt, t1.modelEndedAt, t1.endedAt]) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(before);
            expect(v).toBeLessThanOrEqual(after);
        }
        expect(t1.startedAt).toBeLessThanOrEqual(t1.modelEndedAt);
        expect(t1.modelEndedAt).toBeLessThanOrEqual(t1.endedAt);
        // Both tools, by id, each closed before the step closed.
        expect(t1.tools?.map((t) => t.toolCallId).sort()).toEqual(["c1", "c2"]);
        for (const tool of t1.tools ?? []) {
            expect(tool.toolName).toBe("ls");
            expect(tool.endedAt).toBeDefined();
            expect(tool.startedAt).toBeLessThanOrEqual(tool.endedAt!);
            expect(tool.endedAt!).toBeLessThanOrEqual(t1.endedAt);
            expect(tool.error).toBeUndefined();
        }

        // The answer step: no tools, streamed text → a first-token stamp.
        const t2 = finalStep.timing as StepTiming;
        expect(t2).toBeDefined();
        expect(t2.tools).toBeUndefined();
        expect(t2.firstTokenAt).toBeDefined();
        expect(t2.startedAt).toBeLessThanOrEqual(t2.firstTokenAt!);
        expect(t2.firstTokenAt!).toBeLessThanOrEqual(t2.modelEndedAt);
        // Steps don't overlap.
        expect(t1.endedAt).toBeLessThanOrEqual(t2.startedAt);

        // Tool-result entries carry none of it (it rides the assistant entry).
        const toolEntries = (reloaded.entries() as any[]).filter((e) => e.type === "message" && e.role === "tool");
        expect(toolEntries.length).toBeGreaterThan(0);
        expect(toolEntries.every((e) => e.timing === undefined)).toBe(true);
        // And it never leaks into the model context.
        const { toModelMessages } = await import("../src/agent/model-messages");
        expect(JSON.stringify(toModelMessages(reloaded))).not.toContain("modelEndedAt");
    });

    test("an interrupted step still gets a closed bar", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-timing-int-"));
        const { info, session } = mkSession(dir);
        const text = "Roses are red and violets are blue";
        currentModel = new MockLanguageModelV3({
            doStream: async () =>
                streamOf([
                    { type: "text-start", id: "t0" },
                    ...text.split("").map((c) => ({ type: "text-delta", id: "t0", delta: c })),
                    { type: "text-end", id: "t0" },
                    {
                        type: "finish",
                        finishReason: { unified: "stop", raw: "end_turn" },
                        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                    },
                ]),
        });
        const { runTurn, CostTracker } = await import("../src/agent");
        const abort = new AbortController();
        const em = new EventEmitter() as any;
        let seen = "";
        em.on("text-delta", (t: string) => {
            seen += t;
            if (seen.length >= 8) abort.abort();
        });
        await runTurn({
            session,
            modelId: MODEL,
            userInput: "write a poem",
            cwd: dir,
            abortSignal: abort.signal,
            tracker: new CostTracker(),
            emitter: em,
        });

        const entry = assistantEntries(Session.load(join(dir, "s.jsonl"), info)).pop();
        expect(entry?.interrupted).toBe(true);
        const t = entry?.timing as StepTiming;
        expect(t).toBeDefined();
        expect(t.startedAt).toBeLessThanOrEqual(t.endedAt);
        expect(t.modelEndedAt).toBe(t.endedAt);
        // Text streamed before the interrupt, so the first-token stamp is real.
        expect(t.firstTokenAt).toBeDefined();
        expect(t.firstTokenAt!).toBeGreaterThanOrEqual(t.startedAt);
    });
});

describe("timing on read", () => {
    const base = { type: "message", role: "assistant", content: [], ts: 1000 };

    test("a well-formed timing round-trips, extras dropped", () => {
        const e = adaptSessionEntry({
            ...base,
            timing: {
                startedAt: 1,
                firstTokenAt: 2,
                modelEndedAt: 3,
                endedAt: 5,
                retryWaitMs: 7,
                tools: [
                    { toolCallId: "a", toolName: "ls", startedAt: 2, endedAt: 4, error: true, bogus: 1 },
                    { toolName: "no-id", startedAt: 2 },
                    "junk",
                ],
                bogus: true,
            },
        }) as any;
        expect(e.timing).toEqual({
            startedAt: 1,
            firstTokenAt: 2,
            modelEndedAt: 3,
            endedAt: 5,
            retryWaitMs: 7,
            tools: [{ toolCallId: "a", toolName: "ls", startedAt: 2, endedAt: 4, error: true }],
        });
    });

    test("a malformed timing is dropped, not repaired", () => {
        for (const timing of [null, "soon", 42, {}, { startedAt: 1, endedAt: 2 }, { startedAt: "1", modelEndedAt: 2, endedAt: 3 }]) {
            const e = adaptSessionEntry({ ...base, timing }) as any;
            expect(e.type).toBe("message");
            expect("timing" in e).toBe(false);
        }
    });

    test("an entry recorded before timing existed has no timing key at all", () => {
        const e = adaptSessionEntry({ ...base, reasoningMs: [12] }) as any;
        expect("timing" in e).toBe(false);
        expect(e.reasoningMs).toEqual([12]);
    });
});
