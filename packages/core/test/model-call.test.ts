import { describe, expect, test } from "bun:test";
import { buildAgentCallConfig, createStepBilling, createYieldGate } from "../src/agent/model-call";
import { CostTracker } from "../src/agent/cost";
import type { ModelInfo, UsageBlock } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

const info = (over: Partial<ModelInfo> = {}): ModelInfo =>
    ({ name: "m", contextWindow: 200_000, maxOutput: 64_000, reasoning: true, ...over }) as ModelInfo;

const usage = (input: number, output: number): UsageBlock => ({
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
});

describe("buildAgentCallConfig", () => {
    test("anthropic: caching + output cap + moving-tail prepareStep", () => {
        const cfg = buildAgentCallConfig({
            provider: "anthropic",
            modelShortId: "claude-x",
            thinkingLevel: "off",
            modelInfo: info(),
        });
        expect(cfg.anthropicCaching).toBe(true);
        expect(cfg.maxOutputTokens).toBe(64_000);
        expect(cfg.prepareStep).toBeInstanceOf(Function);
    });

    test("non-anthropic: no caching, no cap, no prepareStep", () => {
        const cfg = buildAgentCallConfig({
            provider: "openai",
            modelShortId: "gpt-x",
            thinkingLevel: "off",
            modelInfo: info(),
        });
        expect(cfg.anthropicCaching).toBe(false);
        expect(cfg.maxOutputTokens).toBeUndefined();
        expect(cfg.prepareStep).toBeUndefined();
    });

    test("reasoning-incapable model gets neither reasoning nor providerOptions", () => {
        const cfg = buildAgentCallConfig({
            provider: "openai",
            modelShortId: "gpt-x",
            thinkingLevel: "high",
            modelInfo: info({ reasoning: false }),
        });
        expect(cfg.reasoning).toBeUndefined();
        expect(cfg.providerOptions).toBeUndefined();
    });
});

describe("createStepBilling", () => {
    test("accrues the sum, bills the tracker, queues row ids in step order", () => {
        const tracker = new CostTracker({ persist: false });
        const billing = createStepBilling(tracker, "anthropic/claude-x", { source: "turn" });
        expect(billing.sum).toBeUndefined();
        billing.onStepUsage(usage(100, 10));
        billing.onStepUsage(usage(200, 20));
        expect(billing.sum?.inputTokens).toBe(300);
        expect(billing.sum?.outputTokens).toBe(30);
        // persist:false writes no ledger rows — the id queue mirrors that
        // (attribution is optional; the money went through tracker.add).
        expect(billing.rowIds).toEqual([]);
        expect(tracker.sessionBreakdown().inputTokens).toBe(300);
    });
});

describe("createYieldGate", () => {
    test("yields only after the interval elapses", async () => {
        const maybeYield = createYieldGate(10_000);
        // Fresh gate: interval not elapsed — must resolve synchronously-ish
        // without a macrotask hop (observable as immediate resolution order).
        let hopped = false;
        setImmediate(() => {
            hopped = true;
        });
        await maybeYield();
        expect(hopped).toBe(false); // no setImmediate round-trip happened
        const eager = createYieldGate(0);
        await eager();
        expect(hopped).toBe(true); // interval 0 → real yield ran the check phase
    });
});
