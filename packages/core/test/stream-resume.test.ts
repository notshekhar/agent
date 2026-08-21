/**
 * A turn that reopens its stream after a transient provider failure.
 *
 * Before this, a 529 at step 18 of 20 ended the turn: the finished steps were
 * persisted and billed, and everything they had built toward was thrown away.
 * These tests drive the real loop with a mock model that fails on demand.
 *
 * The rule being pinned down: resume only BETWEEN steps. With half a step's
 * text already on screen, a resumed stream would regenerate it and the user
 * would read it twice — so that case reports the error like it always did.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { Session } from "../src/sessions";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

// Same delegating-mock pattern as abort-persistence.test.ts: bun module mocks
// leak across files, so the mock stays installed and only fakes getModel while
// a test has set currentModel.
let currentModel: MockLanguageModelV3 | null = null;
const realProviders = await import("../src/providers");
mock.module("../src/providers", () => ({
    ...realProviders,
    getModel: async (...args: Parameters<typeof realProviders.getModel>) =>
        currentModel ?? realProviders.getModel(...args),
}));

const MODEL = "xai/grok-build-0.1";

type Part = Record<string, unknown>;

const textParts = (id: string, text: string): Part[] => [
    { type: "text-start", id },
    ...text.split("").map((c) => ({ type: "text-delta", id, delta: c })),
    { type: "text-end", id },
];

const FINISH: Part = {
    type: "finish",
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
};

/** A stream that emits `parts` then closes. */
function streamOf(parts: Part[]) {
    let i = 0;
    return {
        stream: new ReadableStream({
            async pull(controller) {
                await new Promise((r) => setTimeout(r, 1));
                if (i < parts.length) controller.enqueue(parts[i++]);
                else controller.close();
            },
        }),
    };
}

function mkSession(dir: string) {
    return new Session({ id: "t", createdAt: 0, cwd: dir, provider: "xai", model: MODEL }, join(dir, "s.jsonl"), []);
}

/** Run a turn whose stream behaves differently on each attempt. */
async function runWithAttempts(dir: string, attempts: Part[][], opts: { maxSteps?: number } = {}) {
    let attempt = 0;
    const seen: number[] = [];
    currentModel = new MockLanguageModelV3({
        doStream: async () => {
            const parts = attempts[Math.min(attempt, attempts.length - 1)];
            seen.push(attempt);
            attempt++;
            return streamOf(parts);
        },
    });
    const { runTurn, CostTracker } = await import("../src/agent");
    const session = mkSession(dir);
    const em = new EventEmitter();
    const events: Array<{ type: string; payload: unknown }> = [];
    for (const name of ["error", "stream-retry", "finish", "text-delta"]) {
        em.on(name, (payload: unknown) => events.push({ type: name, payload }));
    }
    await runTurn({
        session,
        modelId: MODEL,
        userInput: "do the thing",
        cwd: dir,
        tracker: new CostTracker({ persist: false }),
        emitter: em as never,
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    });
    return {
        attempts: attempt,
        events,
        session,
        text: events
            .filter((e) => e.type === "text-delta")
            .map((e) => e.payload)
            .join(""),
        errors: events.filter((e) => e.type === "error"),
        retries: events.filter((e) => e.type === "stream-retry"),
    };
}

describe("a transient failure between steps is resumed", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "loop-resume-"));
    });
    afterEach(() => {
        currentModel = null;
        mock.restore();
    });

    test("an overload error reopens the stream and the turn completes", async () => {
        const run = await runWithAttempts(dir, [
            // First attempt: dies before producing anything.
            [{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
            // Second: the real answer.
            [...textParts("t1", "recovered"), FINISH],
        ]);
        expect(run.attempts).toBe(2);
        expect(run.text).toBe("recovered");
        // A turn that recovered reports no error at all — only the retry.
        expect(run.errors).toHaveLength(0);
        expect(run.retries).toHaveLength(1);
        expect(run.retries[0].payload).toMatchObject({ attempt: 1, max: 2 });
    });

    test("the retry is announced, with a reason", async () => {
        const run = await runWithAttempts(dir, [
            [{ type: "error", error: "overloaded_error" }],
            [...textParts("t1", "ok"), FINISH],
        ]);
        expect((run.retries[0].payload as { reason: string }).reason).toContain("overloaded");
    });

    test("giving up after the last attempt reports the error", async () => {
        // Every attempt fails: 1 initial + 2 resumes = 3 streams, then report.
        const run = await runWithAttempts(dir, [[{ type: "error", error: "overloaded_error" }]]);
        expect(run.attempts).toBe(3);
        expect(run.retries).toHaveLength(2);
        expect(run.errors).toHaveLength(1);
    });

    test("a permanent error is reported at once, without burning retries", async () => {
        const run = await runWithAttempts(dir, [
            [{ type: "error", error: new Error("invalid_request_error: bad tool schema") }],
        ]);
        expect(run.attempts).toBe(1);
        expect(run.retries).toHaveLength(0);
        expect(run.errors).toHaveLength(1);
    });
});

describe("what is not resumed", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "loop-resume-"));
    });
    afterEach(() => {
        currentModel = null;
        mock.restore();
    });

    test("a failure mid-text is reported, so nothing is said twice", async () => {
        // Half a sentence has already reached the user. Regenerating that step
        // would repeat it, which is worse than surfacing the error.
        const run = await runWithAttempts(dir, [
            [...textParts("t1", "half a thought").slice(0, 8), { type: "error", error: "overloaded_error" }],
            [...textParts("t2", "second"), FINISH],
        ]);
        expect(run.attempts).toBe(1);
        expect(run.retries).toHaveLength(0);
        expect(run.errors).toHaveLength(1);
    });

    test("a stream that finished is never reopened", async () => {
        const run = await runWithAttempts(dir, [[...textParts("t1", "done"), FINISH]]);
        expect(run.attempts).toBe(1);
        expect(run.retries).toHaveLength(0);
        expect(run.errors).toHaveLength(0);
    });
});

describe("the failed stream's own step is not counted", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "loop-resume-"));
    });
    afterEach(() => {
        currentModel = null;
        mock.restore();
    });

    // The SDK closes a failed stream with a synthetic finish-step
    // (finishReason "error"). Counting it would spend the turn's step budget
    // on a step that produced nothing — with maxSteps 1, the resume below
    // would have no budget left and the turn would end on the error.
    test("a turn with a one-step budget still gets its resume", async () => {
        const run = await runWithAttempts(
            dir,
            [[{ type: "error", error: "overloaded_error" }], [...textParts("t1", "recovered"), FINISH]],
            { maxSteps: 1 },
        );
        expect(run.attempts).toBe(2);
        expect(run.text).toBe("recovered");
        expect(run.errors).toHaveLength(0);
    });
});
