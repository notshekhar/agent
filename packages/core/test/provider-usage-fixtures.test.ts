import { describe, expect, test } from "bun:test";
import { priceUsage } from "../src/agent/cost";
import { normalizeUsage } from "../src/sessions/usage";
import type { UsageBlock } from "../src/types";

/**
 * The §1b P0 gate: pin how each provider's finish-step usage maps into the
 * fields loop bills on. Verified 2026-07-05 against the installed adapter
 * SOURCES (the convertUsage functions that construct the block), not live
 * calls — every adapter emits the ai-sdk v3 shape
 * `{ total, noCache, cacheRead, cacheWrite }` and `ai` v7's
 * asLanguageModelUsage maps total → usage.inputTokens (cache-INCLUSIVE) and
 * noCache → inputTokenDetails.noCacheTokens:
 *
 * - @ai-sdk/anthropic  convertAnthropicUsage: total = input_tokens + cache_creation + cache_read; noCache = input_tokens
 * - @ai-sdk/openai:    total = prompt_tokens (inclusive per OpenAI docs); noCache = prompt − cached
 * - @ai-sdk/google:    total = promptTokens (inclusive); noCache = prompt − cachedContent
 * - @ai-sdk/xai:       normalizes BOTH conventions to inclusive-total + explicit noCache
 * - @ai-sdk/amazon-bedrock: total = inputTokens + cacheRead + cacheWrite; noCache = inputTokens
 * - @openrouter/ai-sdk-provider: total = inputTokens (OpenAI convention), noCache undefined,
 *   cacheRead = cachedTokens — the subtraction fallback applies and is correct;
 *   billing prefers provider-reported usage.cost anyway.
 * - ollama-ai-provider-v2: bare totals, no cache classes — billed at full input rate.
 *
 * If an adapter bump changes any of these conventions, these fixtures are the
 * tripwire. The blocks below are shaped exactly as asLanguageModelUsage
 * delivers them to onStepFinish.
 */

// anthropic/claude-opus-4-5 catalog prices: in $5, out $25, cacheRead $0.5, cacheWrite $6.25 per MTok
const MODEL = "anthropic/claude-opus-4-5";

/** ai-sdk v7 shape with explicit noCache (anthropic/openai/google/xai/bedrock). */
const v7Usage = (parts: { noCache: number; cacheRead: number; cacheWrite: number; output: number }): UsageBlock => ({
    inputTokens: parts.noCache + parts.cacheRead + parts.cacheWrite,
    inputTokenDetails: {
        noCacheTokens: parts.noCache,
        cacheReadTokens: parts.cacheRead,
        cacheWriteTokens: parts.cacheWrite,
    },
    outputTokens: parts.output,
    outputTokenDetails: { textTokens: parts.output, reasoningTokens: 0 },
    totalTokens: parts.noCache + parts.cacheRead + parts.cacheWrite + parts.output,
});

describe("provider usage fixtures (inclusivity gate)", () => {
    test("explicit noCache (anthropic/openai/google/xai/bedrock shape) bills each class once", () => {
        // 1M fresh + 2M cache-read + 400k cache-write + 100k out
        const u = v7Usage({ noCache: 1_000_000, cacheRead: 2_000_000, cacheWrite: 400_000, output: 100_000 });
        const priced = priceUsage(MODEL, u)!;
        expect(priced.details.input).toBeCloseTo(5, 6); // 1M × $5
        expect(priced.details.cacheRead).toBeCloseTo(1, 6); // 2M × $0.5
        expect(priced.details.cacheWrite).toBeCloseTo(2.5, 6); // 400k × $6.25
        expect(priced.details.output).toBeCloseTo(2.5, 6); // 100k × $25
        expect(priced.usd).toBeCloseTo(11, 6);
    });

    test("openrouter shape (no noCache detail) falls back to inclusive-total subtraction", () => {
        const u: UsageBlock = {
            inputTokens: 3_000_000, // inclusive (OpenAI convention)
            inputTokenDetails: { cacheReadTokens: 2_000_000 }, // no noCacheTokens, no cacheWrite
            outputTokens: 0,
            totalTokens: 3_000_000,
        };
        const priced = priceUsage(MODEL, u)!;
        expect(priced.details.input).toBeCloseTo(5, 6); // (3M − 2M) × $5
        expect(priced.details.cacheRead).toBeCloseTo(1, 6);
        expect(priced.usd).toBeCloseTo(6, 6);
    });

    test("ollama shape (bare totals) bills the whole input at the full rate", () => {
        const u: UsageBlock = { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 };
        const priced = priceUsage(MODEL, u)!;
        expect(priced.details.input).toBeCloseTo(5, 6);
        expect(priced.details.cacheRead).toBe(0);
        expect(priced.usd).toBeCloseTo(5, 6);
    });

    test("legacy v6 flat shape (cachedInputTokens) still resolves through normalizeUsage precedence", () => {
        const u: UsageBlock = {
            inputTokens: 3_000_000,
            cachedInputTokens: 2_000_000,
            outputTokens: 0,
            totalTokens: 3_000_000,
        };
        const n = normalizeUsage(u);
        expect(n.cacheRead).toBe(2_000_000);
        const priced = priceUsage(MODEL, u)!;
        expect(priced.details.input).toBeCloseTo(5, 6); // (3M − 2M) × $5
        expect(priced.details.cacheRead).toBeCloseTo(1, 6);
    });
});
