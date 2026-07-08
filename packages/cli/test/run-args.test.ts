import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/args";

describe("run-mode arg parsing", () => {
    test("--max-steps with a space-separated value", () => {
        const args = parseArgs(["run", "do the thing", "--max-steps", "40"]);
        expect(args.cmd).toBe("run");
        expect(args.positional).toEqual(["do the thing"]);
        expect(args.flags["max-steps"]).toBe("40");
    });

    test("--max-steps=N form", () => {
        const args = parseArgs(["run", "prompt", "--max-steps=25"]);
        expect(args.flags["max-steps"]).toBe("25");
    });

    test("a lone - survives as a positional (stdin prompt marker)", () => {
        const args = parseArgs(["run", "-", "--model", "anthropic/claude-fable-5"]);
        expect(args.cmd).toBe("run");
        expect(args.positional).toEqual(["-"]);
        expect(args.flags.model).toBe("anthropic/claude-fable-5");
    });

    test("flags mixed around the prompt keep the prompt intact", () => {
        const args = parseArgs(["run", "--model", "openai/gpt-5", "review", "this"]);
        expect(args.flags.model).toBe("openai/gpt-5");
        expect(args.positional.join(" ")).toBe("review this");
    });
});
