import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    test("--session with a space-separated id", () => {
        const args = parseArgs(["run", "continue", "--session", "01KXV2MFZ3GGQ3WSP0ZMM1Y5E2"]);
        expect(args.flags.session).toBe("01KXV2MFZ3GGQ3WSP0ZMM1Y5E2");
        expect(args.positional).toEqual(["continue"]);
    });
});

describe("readStdinAll", () => {
    // Spawned subprocesses because stdin's kind is the variable under test:
    // the stream path saw EOF-without-data for regular-file stdin in the
    // bundled build (`loop run - < file`), while pipes worked by timing (#5).
    const script = join(import.meta.dir, "..", "src", "args.ts");
    const runner = `import { readStdinAll } from ${JSON.stringify(script)}; process.stdout.write(JSON.stringify(await readStdinAll()));`;

    test("reads all of a regular-file stdin (shell redirect)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-stdin-"));
        const file = join(dir, "prompt.txt");
        writeFileSync(file, "prompt from a redirect\n");
        const proc = Bun.spawn(["bun", "-e", runner], { stdin: Bun.file(file), stdout: "pipe" });
        expect(await proc.stdout.text()).toBe(JSON.stringify("prompt from a redirect\n"));
    });

    test("reads all of a piped stdin", async () => {
        const proc = Bun.spawn(["bun", "-e", runner], { stdin: "pipe", stdout: "pipe" });
        proc.stdin.write("prompt from a pipe\n");
        await proc.stdin.end();
        expect(await proc.stdout.text()).toBe(JSON.stringify("prompt from a pipe\n"));
    });
});
