import { describe, expect, test } from "bun:test";
import { buildFollowUpThread, taskToolModelOutput, type SubagentOutput } from "../src/agent/subagent";
import { sumUsage } from "../src/agent/cost";
import type { Entry, UsageBlock } from "../src/types";

const out = (report: string): SubagentOutput => ({ history: [{ type: "text", text: report }], report });

describe("taskToolModelOutput — what the parent model reads", () => {
    test("SDK options-object call shape delivers the report (regression)", () => {
        // The AI SDK invokes toModelOutput({ toolCallId, input, output }) — the
        // report must be read from options.output, not from the wrapper.
        const r = taskToolModelOutput({
            toolCallId: "task-1",
            input: { prompt: "explore" },
            output: out("## Report\neverything works"),
        } as { output: unknown });
        expect(r).toEqual({ type: "text", value: "## Report\neverything works" });
    });

    test("empty report falls back to a non-empty placeholder", () => {
        const r = taskToolModelOutput({ output: out("") });
        expect(r.value).toBe("(subagent finished without a final response)");
    });

    test("oversized report is bounded with a truncation note", () => {
        const r = taskToolModelOutput({ output: out("x".repeat(30_000)) });
        expect(r.value.length).toBeLessThan(30_000);
        expect(r.value).toContain("truncated");
    });

    test("hook feedback on the output object stays visible to the parent", () => {
        const o = { ...out("done"), hook_feedback: "BLOCKED: nope" };
        const r = taskToolModelOutput({ output: o });
        expect(r.value).toContain("done");
        expect(r.value).toContain("BLOCKED: nope");
    });

    test("run stats never leak into what the model reads", () => {
        const o: SubagentOutput = {
            ...out("clean report"),
            stats: { steps: 7, durationMs: 4200, usd: 0.05, model: "anthropic/x" },
        };
        expect(taskToolModelOutput({ output: o }).value).toBe("clean report");
    });
});

describe("buildFollowUpThread — resuming a prior subagent run", () => {
    const run = (
        toolCallId: string,
        prompt: string,
        result: string,
        extra: Partial<Extract<Entry, { type: "subagent" }>> = {},
    ): Entry => ({
        type: "subagent",
        ts: 1,
        agent: "default",
        prompt,
        result,
        toolCallId,
        ...extra,
    });

    test("unknown id returns undefined (caller runs fresh with a warning)", () => {
        expect(buildFollowUpThread([run("t1", "p", "r")], "nope")).toBeUndefined();
    });

    test("single run becomes a user/assistant pair with the run's agent", () => {
        const thread = buildFollowUpThread(
            [run("t1", "find the config", "it's in src/config.ts", { agent: "plan" })],
            "t1",
        );
        expect(thread?.agent).toBe("plan");
        expect(thread?.messages).toEqual([
            { role: "user", content: "find the config" },
            { role: "assistant", content: "it's in src/config.ts" },
        ]);
    });

    test("transcript prefers the flattened activity over the bare report", () => {
        const thread = buildFollowUpThread(
            [
                run("t1", "p", "report only", {
                    activity: [
                        { type: "tool", name: "grep", summary: " loadConfig" },
                        { type: "text", text: "found 3 call sites" },
                    ],
                }),
            ],
            "t1",
        );
        const transcript = thread?.messages[1].content as string;
        expect(transcript).toContain("> grep loadConfig");
        expect(transcript).toContain("found 3 call sites");
    });

    test("followUpOf chains replay oldest-first", () => {
        const entries = [
            run("t1", "first prompt", "first answer"),
            run("t2", "second prompt", "second answer", { followUpOf: "t1" }),
        ];
        const thread = buildFollowUpThread(entries, "t2");
        expect(thread?.messages.map((m) => m.content)).toEqual([
            "first prompt",
            "first answer",
            "second prompt",
            "second answer",
        ]);
    });

    test("a cyclic followUpOf chain terminates", () => {
        const entries = [run("t1", "a", "ra", { followUpOf: "t2" }), run("t2", "b", "rb", { followUpOf: "t1" })];
        const thread = buildFollowUpThread(entries, "t2");
        expect(thread).toBeDefined();
        expect(thread!.messages.length).toBeLessThanOrEqual(4);
    });

    test("oversized transcripts are tail-capped with a note", () => {
        const thread = buildFollowUpThread([run("t1", "p", "x".repeat(20_000))], "t1");
        const transcript = thread?.messages[1].content as string;
        expect(transcript.length).toBeLessThan(20_000);
        expect(transcript).toContain("[earlier activity truncated]");
    });
});

describe("sumUsage — abort-safe per-step accumulation", () => {
    const u = (i: number, o: number, cr?: number): UsageBlock => ({
        inputTokens: i,
        outputTokens: o,
        totalTokens: i + o,
        ...(cr !== undefined ? { inputTokenDetails: { cacheReadTokens: cr } } : {}),
    });

    test("undefined seed copies the block", () => {
        expect(sumUsage(undefined, u(100, 10))).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    });

    test("sums tokens and cache details across steps", () => {
        const total = sumUsage(sumUsage(undefined, u(100, 10, 80)), u(200, 20, 150));
        expect(total.inputTokens).toBe(300);
        expect(total.outputTokens).toBe(30);
        expect(total.totalTokens).toBe(330);
        expect(total.inputTokenDetails?.cacheReadTokens).toBe(230);
    });

    test("absent fields stay undefined rather than becoming 0", () => {
        const total = sumUsage(sumUsage(undefined, u(1, 1)), u(2, 2));
        expect(total.reasoningTokens).toBeUndefined();
        expect(total.cost).toBeUndefined();
    });
});
