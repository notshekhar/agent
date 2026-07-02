import { afterEach, describe, expect, test } from "bun:test";
import { askInputSchema, createAskTool, formatAskAnswers } from "../src/tools/ask";
import {
    getAskUserBridge,
    isAskUserAvailable,
    setAskUserBridge,
    type AskAnswer,
    type AskQuestion,
    type AskUserBridge,
} from "../src/tools/ask-bridge";

const q = (over: Partial<AskQuestion> = {}): AskQuestion => ({
    question: "Which auth method should I implement?",
    header: "Auth method",
    options: [
        { label: "OAuth2", description: "redirect flow" },
        { label: "API key", description: "static key from env" },
    ],
    ...over,
});

const execute = async (tool: ReturnType<typeof createAskTool>, questions: AskQuestion[], signal?: AbortSignal) =>
    (await tool.execute!({ questions }, { toolCallId: "t1", messages: [], abortSignal: signal } as never)) as string;

afterEach(() => setAskUserBridge(null));

describe("ask bridge registry", () => {
    test("round-trips and signals availability", () => {
        expect(isAskUserAvailable()).toBe(false);
        expect(getAskUserBridge()).toBeNull();
        const bridge: AskUserBridge = { ask: async () => [] };
        setAskUserBridge(bridge);
        expect(isAskUserAvailable()).toBe(true);
        expect(getAskUserBridge()).toBe(bridge);
        setAskUserBridge(null);
        expect(isAskUserAvailable()).toBe(false);
    });
});

describe("askInputSchema", () => {
    test("accepts a valid multi-question payload", () => {
        const parsed = askInputSchema.parse({ questions: [q(), q({ multiSelect: true })] });
        expect(parsed.questions).toHaveLength(2);
    });

    test("rejects empty and oversized question lists", () => {
        expect(() => askInputSchema.parse({ questions: [] })).toThrow();
        expect(() => askInputSchema.parse({ questions: [q(), q(), q(), q(), q()] })).toThrow();
    });

    test("rejects too few / too many options and empty header", () => {
        expect(() => askInputSchema.parse({ questions: [q({ options: [q().options[0]] })] })).toThrow();
        expect(() =>
            askInputSchema.parse({
                questions: [q({ options: Array(5).fill({ label: "x", description: "" }) })],
            }),
        ).toThrow();
        expect(() => askInputSchema.parse({ questions: [q({ header: "" })] })).toThrow();
    });
});

describe("formatAskAnswers", () => {
    test("formats picked labels with header chips", () => {
        const out = formatAskAnswers([q()], [{ answers: ["OAuth2"] }]);
        expect(out).toContain("[Auth method] Which auth method should I implement?");
        expect(out).toContain("→ OAuth2");
    });

    test("formats multi-select and custom answers", () => {
        const out = formatAskAnswers(
            [q({ multiSelect: true }), q({ header: "Style" })],
            [{ answers: ["OAuth2", "API key"] }, { answers: ["match house style"], custom: true }],
        );
        expect(out).toContain("(multi-select)");
        expect(out).toContain("→ OAuth2, API key");
        expect(out).toContain('→ (custom answer) "match house style"');
    });

    test("marks skipped trailing questions", () => {
        const out = formatAskAnswers(
            [q(), q({ header: "Style" })],
            [{ answers: ["OAuth2"] }, { answers: [], declined: true }],
        );
        expect(out).toContain("→ OAuth2");
        expect(out).toContain("(no answer — user skipped this question)");
    });

    test("collapses to a decline message when everything was skipped", () => {
        const out = formatAskAnswers([q()], [{ answers: [], declined: true }]);
        expect(out).toBe("The user declined to answer. Proceed with your best judgment.");
    });
});

describe("createAskTool execute", () => {
    test("returns the unavailable notice when no bridge is registered", async () => {
        const out = await execute(createAskTool({}), [q()]);
        expect(out).toContain("not available");
    });

    test("passes questions to the bridge and formats its answers", async () => {
        let seen: AskQuestion[] | undefined;
        setAskUserBridge({
            ask: async (questions) => {
                seen = questions;
                return [{ answers: ["API key"] }];
            },
        });
        const out = await execute(createAskTool({}), [q()]);
        expect(seen).toHaveLength(1);
        expect(out).toContain("→ API key");
    });

    test("throws when the signal is already aborted", async () => {
        setAskUserBridge({ ask: async () => [{ answers: ["OAuth2"] }] });
        const ac = new AbortController();
        ac.abort();
        await expect(execute(createAskTool({}), [q()], ac.signal)).rejects.toThrow("Operation aborted");
    });

    test("throws when aborted while waiting on the bridge", async () => {
        const ac = new AbortController();
        setAskUserBridge({
            ask: (questions, opts) =>
                new Promise<AskAnswer[]>((resolve) => {
                    opts?.signal?.addEventListener("abort", () =>
                        resolve(questions.map(() => ({ answers: [], declined: true }))),
                    );
                }),
        });
        const pending = execute(createAskTool({}), [q()], ac.signal);
        ac.abort();
        await expect(pending).rejects.toThrow("Operation aborted");
    });
});
