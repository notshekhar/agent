/**
 * The three shapes `loop run` can report in.
 *
 * Driven by a synthetic emitter — no provider, no network, no cost. The point
 * of the machine formats is that a script can read a run without scraping
 * stderr, so the tests are mostly about what lands on which stream.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { asTurnEmitter } from "@notshekhar/loop-core";
import { createReporter, type RunContext } from "../src/print/reporters";
import type { OutputFormat } from "../src/spec";

const CTX: RunContext = { sessionId: "01TESTSESSION", model: "anthropic/claude-fable-5", cwd: "/tmp/project" };

/** Run a scripted turn through a reporter, capturing both streams. */
function capture(format: OutputFormat, script: (emit: (event: string, payload?: unknown) => void) => void) {
    const out: string[] = [];
    const err: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => {
        out.push(String(s));
        return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => {
        err.push(String(s));
        return true;
    }) as typeof process.stderr.write;
    try {
        const emitter = new EventEmitter();
        const reporter = createReporter(format);
        reporter.attach(asTurnEmitter(emitter));
        reporter.begin(CTX);
        script((event, payload) => void emitter.emit(event, payload));
        reporter.end({
            ok: !reporter.errored,
            cost: { inputTokens: 120, outputTokens: 45, cachedInputTokens: 100, usd: 0.0123 },
            durationMs: 1234,
        });
        return { stdout: out.join(""), stderr: err.join(""), errored: reporter.errored };
    } finally {
        process.stdout.write = realOut;
        process.stderr.write = realErr;
    }
}

/** A representative turn: some text, a tool call, a step, a finish. */
const typicalTurn = (emit: (event: string, payload?: unknown) => void) => {
    emit("text-delta", "Hello ");
    emit("tool-call", { toolName: "read", input: { path: "/tmp/a.txt" }, toolCallId: "c1" });
    emit("tool-result", { toolCallId: "c1", output: "contents" });
    emit("step-usage", { usage: { inputTokens: 120, outputTokens: 45 }, breakdown: { usd: 0.0123 } });
    emit("text-delta", "world.");
    emit("finish", { usage: { totalTokens: 165 } });
};

describe("text format", () => {
    test("model text goes to stdout, activity to stderr", () => {
        const { stdout, stderr } = capture("text", typicalTurn);
        expect(stdout).toContain("Hello world.");
        expect(stderr).toContain("[tool:read]");
        expect(stdout).not.toContain("[tool:read]");
    });

    test("the session id is reported so a follow-up can resume it", () => {
        // Before the turn and on stderr: a run that dies mid-way still says
        // what to pass to --session.
        const { stderr, stdout } = capture("text", () => {});
        expect(stderr).toContain("01TESTSESSION");
        expect(stdout).not.toContain("01TESTSESSION");
    });

    test("the cost line still ends the run", () => {
        const { stderr } = capture("text", typicalTurn);
        expect(stderr).toContain("$0.0123");
        expect(stderr).toContain("in:120 out:45 cache:100");
    });
});

describe("json format", () => {
    const parse = (s: string) => JSON.parse(s.trim());

    test("stdout is exactly one parseable object", () => {
        const { stdout } = capture("json", typicalTurn);
        expect(stdout.trimEnd().split("\n")).toHaveLength(1);
        expect(() => parse(stdout)).not.toThrow();
    });

    test("the object carries the reply, the session and the accounting", () => {
        const result = parse(capture("json", typicalTurn).stdout);
        expect(result).toMatchObject({
            type: "result",
            is_error: false,
            session_id: "01TESTSESSION",
            model: "anthropic/claude-fable-5",
            cwd: "/tmp/project",
            result: "Hello world.",
            steps: 1,
            duration_ms: 1234,
            usd: 0.0123,
            usage: { input_tokens: 120, output_tokens: 45, cached_input_tokens: 100 },
        });
    });

    test("no errors key when nothing went wrong", () => {
        expect(parse(capture("json", typicalTurn).stdout).errors).toBeUndefined();
    });

    test("a stream error marks the result and is reported, not just counted", () => {
        const { stdout, errored } = capture("json", (emit) => {
            emit("text-delta", "partial");
            emit("error", new Error("overloaded_error"));
        });
        const result = parse(stdout);
        expect(errored).toBe(true);
        expect(result.is_error).toBe(true);
        // An Error stringifies to {} unless it is handled; the message is the
        // whole reason a caller reads this field.
        expect(result.errors[0]).toEqual({ name: "Error", message: "overloaded_error" });
    });

    test("model text never reaches stdout raw", () => {
        // stdout is the JSON channel; text belongs in the result field.
        const { stdout } = capture("json", (emit) => emit("text-delta", "loose text"));
        expect(stdout.startsWith("{")).toBe(true);
        expect(parse(stdout).result).toBe("loose text");
    });

    test("a hook's terminal escape sequence cannot corrupt the output", () => {
        // In text mode this is written straight through to the terminal.
        const { stdout } = capture("json", (emit) => emit("hook-terminal-sequence", "\u001b]11;#141414\u0007"));
        expect(() => parse(stdout)).not.toThrow();
        expect(stdout).not.toContain("\u001b");
    });
});

describe("stream-json format", () => {
    const lines = (s: string) =>
        s
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));

    test("every line is a parseable object with a type", () => {
        const parsed = lines(capture("stream-json", typicalTurn).stdout);
        for (const line of parsed) expect(typeof line.type).toBe("string");
    });

    test("it opens with init and closes with result", () => {
        const parsed = lines(capture("stream-json", typicalTurn).stdout);
        expect(parsed[0]).toMatchObject({ type: "init", session_id: "01TESTSESSION" });
        expect(parsed[parsed.length - 1]).toMatchObject({ type: "result", is_error: false });
    });

    test("turn events arrive in order, with their payloads", () => {
        const parsed = lines(capture("stream-json", typicalTurn).stdout);
        const types = parsed.map((l) => l.type);
        expect(types).toEqual([
            "init",
            "text-delta",
            "tool-call",
            "tool-result",
            "step-usage",
            "text-delta",
            "finish",
            "result",
        ]);
        expect(parsed[2].data).toMatchObject({ toolName: "read", input: { path: "/tmp/a.txt" } });
    });

    test("the assembled reply still rides the final result", () => {
        // A consumer that does not want to concatenate deltas itself.
        const parsed = lines(capture("stream-json", typicalTurn).stdout);
        expect(parsed[parsed.length - 1].result).toBe("Hello world.");
    });
});
