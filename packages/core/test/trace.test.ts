import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Session } from "../src/sessions";
import { renderTraceHtml, sessionToTrace, traceHeadline } from "../src/trace";
import { oneLine, toolOutputText } from "../src/trace/content";
import { fmtMs, fmtUsd } from "../src/trace/format";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

const MODEL = "anthropic/claude-sonnet-4-6";
const T0 = 1_700_000_000_000;

function mkSession(entries: Entry[]): Session {
    const dir = mkdtempSync(join(tmpdir(), "loop-trace-"));
    const info = { id: "tr", createdAt: T0, cwd: dir, provider: "anthropic" as const, model: MODEL };
    return new Session(info, join(dir, "s.jsonl"), entries);
}

const usage = (input: number, output: number, usd: number) => ({ inputTokens: input, outputTokens: output, usd });

/**
 * Three turns, one per timing provenance:
 *   1. none     — an assistant entry with no user entry before it (legacy
 *                 import): nothing to measure from
 *   2. recorded — two tools (overlapping), a task call with its subagent entry
 *   3. derived  — an old-style turn: user ts then assistant ts only, plus a
 *                 compaction and a follow-up step inside the same turn
 */
function fixture(): Entry[] {
    const t1 = T0 + 1_000;
    return [
        // ---- turn 1: none
        {
            type: "message",
            role: "assistant",
            ts: T0 + 500,
            content: [{ type: "text", text: "orphan" }],
            interrupted: true,
        },
        // ---- turn 2: recorded
        { type: "message", role: "user", content: "fix the scroll bug", ts: t1 },
        {
            type: "message",
            role: "assistant",
            ts: t1 + 4_000,
            model: MODEL,
            usage: usage(1_000, 50, 0.004),
            content: [
                { type: "reasoning", text: "let me look" },
                { type: "text", text: "Reading the files." },
                { type: "tool-call", toolCallId: "a", toolName: "read_file", input: { path: "a.ts" } },
                { type: "tool-call", toolCallId: "b", toolName: "grep", input: { pattern: "scroll" } },
            ],
            reasoningMs: [400],
            timing: {
                startedAt: t1 + 100,
                firstTokenAt: t1 + 600,
                modelEndedAt: t1 + 1_500,
                endedAt: t1 + 4_000,
                tools: [
                    { toolCallId: "a", toolName: "read_file", startedAt: t1 + 1_200, endedAt: t1 + 2_000 },
                    { toolCallId: "b", toolName: "grep", startedAt: t1 + 1_500, endedAt: t1 + 3_900, error: true },
                    { toolCallId: "task-1", toolName: "task", startedAt: t1 + 1_600, endedAt: t1 + 3_800 },
                ],
            },
        },
        {
            type: "message",
            role: "tool",
            ts: t1 + 4_000,
            content: [
                { type: "tool-result", toolCallId: "a", toolName: "read_file", output: { type: "text", value: "x".repeat(10_000) } },
                { type: "tool-result", toolCallId: "b", toolName: "grep", output: { type: "error-text", value: "boom" } },
            ],
        },
        {
            type: "subagent",
            ts: t1 + 3_800,
            agent: "explore",
            prompt: "find the scroll code",
            result: "it's in scroll-view.ts",
            toolCallId: "task-1",
            steps: 3,
            durationMs: 2_200,
            usage: usage(500, 20, 0.001),
            model: MODEL,
        },
        {
            type: "message",
            role: "assistant",
            ts: t1 + 6_000,
            model: MODEL,
            usage: usage(2_000, 100, 0.006),
            content: [{ type: "text", text: "Fixed." }],
            timing: { startedAt: t1 + 4_050, firstTokenAt: t1 + 4_500, modelEndedAt: t1 + 6_000, endedAt: t1 + 6_000, retryWaitMs: 250 },
        },
        // ---- turn 3: derived (pre-timing entries)
        { type: "message", role: "user", content: "and the tests?", ts: t1 + 20_000 },
        {
            type: "message",
            role: "assistant",
            ts: t1 + 23_000,
            usage: usage(3_000, 200, 0.01),
            content: [{ type: "text", text: "Green." }],
        },
        // a compaction mid-turn does not start a turn; the next step measures
        // from the previous step's end
        { type: "compact", ts: t1 + 30_000, summary: "…", cutAt: 5, tokensBefore: 90_000, tokensAfter: 10_000 },
        {
            type: "message",
            role: "assistant",
            ts: t1 + 31_000,
            content: [{ type: "text", text: "Still green." }],
        },
    ];
}

describe("sessionToTrace", () => {
    test("labels every step's timing by where it came from", () => {
        const m = sessionToTrace(mkSession(fixture()));
        expect(m.turns.length).toBe(3);
        expect(m.coverage).toEqual({ recorded: 2, derived: 2, none: 1 });

        const [t1, t2, t3] = m.turns;
        // none carries only the end
        expect(t1.steps.map((s) => s.timing.kind)).toEqual(["none"]);
        expect(t1.steps[0].timing).toEqual({ kind: "none", endedAt: T0 + 500 });
        expect(t1.steps[0].interrupted).toBe(true);
        expect(t1.user.text).toBe("");
        expect(t1.fullyRecorded).toBe(false);

        expect(t2.steps.map((s) => s.timing.kind)).toEqual(["recorded", "recorded"]);
        expect(t2.fullyRecorded).toBe(true);

        // derived = previous anchor → assistant ts, nothing invented in between:
        // the user entry for the first step, the previous step's end for the next
        expect(t3.steps.map((s) => s.timing)).toEqual([
            { kind: "derived", startedAt: T0 + 21_000, endedAt: T0 + 24_000 },
            { kind: "derived", startedAt: T0 + 24_000, endedAt: T0 + 32_000 },
        ]);
        expect(t3.fullyRecorded).toBe(false);
    });

    test("recorded steps carry tool bars, the task call and its subagent", () => {
        const m = sessionToTrace(mkSession(fixture()));
        const s1 = m.turns[1].steps[0];
        expect(s1.timing.kind).toBe("recorded");
        if (s1.timing.kind !== "recorded") throw new Error("unreachable");
        expect(s1.timing.firstTokenAt).toBe(T0 + 1_600);
        expect(s1.reasoning).toBe("let me look");
        expect(s1.reasoningMs).toEqual([400]);

        const byId = Object.fromEntries(s1.tools.map((t) => [t.toolCallId, t]));
        expect(Object.keys(byId).sort()).toEqual(["a", "b", "task-1"]);
        expect(byId.a.timing).toEqual({ startedAt: T0 + 2_200, endedAt: T0 + 3_000 });
        // output capped, but the true size kept
        expect(byId.a.output?.length).toBe(6_000);
        expect(byId.a.outputChars).toBe(10_000);
        // error from the result AND from the timing agree
        expect(byId.b.error).toBe(true);
        expect(byId.b.output).toBe("boom");
        // the filtered task call is rebuilt from its timing + subagent entry
        expect(byId["task-1"].name).toBe("task");
        expect(byId["task-1"].subagent?.agent).toBe("explore");
        expect(byId["task-1"].subagent?.durationMs).toBe(2_200);
        expect(byId["task-1"].input).toBe("find the scroll code");

        const s2 = m.turns[1].steps[1];
        if (s2.timing.kind !== "recorded") throw new Error("unreachable");
        expect(s2.timing.retryWaitMs).toBe(250);
        expect(s2.tools).toEqual([]);
    });

    test("money and tokens add up per turn and overall, subagents included", () => {
        const m = sessionToTrace(mkSession(fixture()));
        const rec = m.turns[1];
        expect(rec.usage.input).toBe(1_000 + 2_000 + 500);
        expect(rec.usage.usd).toBeCloseTo(0.004 + 0.006 + 0.001, 9);
        expect(m.totals.usage.usd).toBeCloseTo(0.011 + 0.01, 9);
        expect(m.totals.steps).toBe(5);
        expect(m.totals.tools).toBe(3);
        expect(m.totals.turns).toBe(3);
        // turn wall time spans from the earliest recorded start to the last end
        expect(rec.startedAt).toBe(T0 + 1_000);
        expect(rec.endedAt).toBe(T0 + 7_000);
        // a compaction inside the turn shows up as an event
        expect(m.turns[2].events.map((e) => e.kind)).toEqual(["compact"]);
    });

    test("an empty session is an empty trace, not an error", () => {
        const m = sessionToTrace(mkSession([]));
        expect(m.turns).toEqual([]);
        expect(m.coverage).toEqual({ recorded: 0, derived: 0, none: 0 });
        expect(traceHeadline(m)).toContain("0 turns");
    });
});

describe("trace formatting", () => {
    test("durations read the way a person says them", () => {
        expect(fmtMs(840)).toBe("840 ms");
        expect(fmtMs(2_340)).toBe("2.3 s");
        expect(fmtMs(14_600)).toBe("15 s");
        expect(fmtMs(72_000)).toBe("1 min 12 s");
        expect(fmtMs(120_000)).toBe("2 min");
    });

    test("money never rounds a real amount to $0.0000", () => {
        expect(fmtUsd(undefined)).toBe("—");
        expect(fmtUsd(0)).toBe("$0");
        expect(fmtUsd(0.0000342)).toBe("$0.000034");
        expect(fmtUsd(0.0071)).toBe("$0.0071");
        expect(fmtUsd(0.157)).toBe("$0.157");
        expect(fmtUsd(12.5)).toBe("$12.50");
    });

    test("tool outputs come out as text whatever shape the SDK used", () => {
        expect(toolOutputText({ type: "text", value: "hi" })).toBe("hi");
        expect(toolOutputText({ type: "error-text", value: "boom" })).toBe("boom");
        expect(toolOutputText({ type: "json", value: { a: 1 } })).toBe('{\n  "a": 1\n}');
        expect(toolOutputText({ type: "content", value: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("a\nb");
        expect(toolOutputText("plain")).toBe("plain");
        expect(toolOutputText(undefined)).toBe("");
        expect(toolOutputText({ unexpected: true })).toBe('{\n  "unexpected": true\n}');
    });

    test("oneLine flattens and caps", () => {
        expect(oneLine({ path: "a.ts", lines: [1, 2] })).toBe('{"path":"a.ts","lines":[1,2]}');
        expect(oneLine("  many\n\n  spaces ")).toBe("many spaces");
        expect(oneLine("x".repeat(300), 10)).toBe("xxxxxxxxxx…");
    });
});

describe("renderTraceHtml", () => {
    test("is one self-contained document with the model embedded safely", () => {
        const hostile = "</script><script>alert(1)</script>";
        const session = mkSession([
            { type: "session-name", name: `<b>${hostile}`, ts: T0 },
            { type: "message", role: "user", content: hostile, ts: T0 },
            {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "ok & fine" }],
                ts: T0 + 10,
                timing: { startedAt: T0 + 1, modelEndedAt: T0 + 10, endedAt: T0 + 10 },
            },
        ]);
        const html = renderTraceHtml(sessionToTrace(session));
        expect(html.startsWith("<!doctype html>")).toBe(true);
        // no external requests
        expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=/);
        // the JSON never contains a literal `<` that could close its script tag
        const json = html.match(/<script id="trace" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
        expect(json).toBeDefined();
        expect(json).not.toContain("<");
        expect(JSON.parse(json!).turns[0].user.text).toBe(hostile);
        // the static header escapes what it prints
        expect(html).toContain("timing recorded for every step");
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("&lt;b&gt;&lt;/script&gt;");
    });

    test("says so when nothing was recorded", () => {
        const html = renderTraceHtml(
            sessionToTrace(
                mkSession([
                    { type: "message", role: "user", content: "hi", ts: T0 },
                    { type: "message", role: "assistant", content: [{ type: "text", text: "hello" }], ts: T0 + 900 },
                ]),
            ),
        );
        expect(html).toContain("timing recorded for 0 of 1 steps · 1 wall-time only · 0 not recorded");
    });
});
