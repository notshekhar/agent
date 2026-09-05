import { describe, expect, test } from "bun:test";
import { formatBangContext, parseBangCommand, runBangCommand } from "../src/interactive/bang-command";

const cwd = process.cwd();

describe("parseBangCommand", () => {
    test("takes everything after the bang, trimmed", () => {
        expect(parseBangCommand("!ls")).toBe("ls");
        expect(parseBangCommand("! ls -la")).toBe("ls -la");
        expect(parseBangCommand("!echo hi | wc -l")).toBe("echo hi | wc -l");
    });

    test("a bare bang is not a command", () => {
        // Otherwise a stray `!` would spawn a shell that runs nothing, and the
        // user would get an empty result they never asked for.
        expect(parseBangCommand("!")).toBeNull();
        expect(parseBangCommand("!   ")).toBeNull();
    });

    test("a bang anywhere but the front is ordinary text", () => {
        expect(parseBangCommand("hello!")).toBeNull();
        expect(parseBangCommand("what does ! do")).toBeNull();
    });
});

describe("runBangCommand", () => {
    test("returns stdout and a zero exit", async () => {
        const r = await runBangCommand("echo hello && echo world", cwd);
        expect(r.output).toBe("hello\nworld\n");
        expect(r.exitCode).toBe(0);
        expect(r.spawnError).toBeUndefined();
    });

    test("merges stderr into stdout, in the order written", async () => {
        // A build's errors are interleaved with its progress; splitting the
        // streams would reorder the one thing the command was run to show.
        const r = await runBangCommand("echo out; echo err 1>&2", cwd);
        expect(r.output).toBe("out\nerr\n");
    });

    test("a non-zero exit is a result, not a throw", async () => {
        const r = await runBangCommand("exit 3", cwd);
        expect(r.exitCode).toBe(3);
        expect(r.spawnError).toBeUndefined();
    });

    test("a missing binary is the shell's 127, with its message as output", async () => {
        const r = await runBangCommand("definitely-not-a-real-binary", cwd);
        expect(r.exitCode).toBe(127);
        expect(r.output).toContain("command not found");
    });

    test("runs in the cwd it is given", async () => {
        const r = await runBangCommand("pwd", "/tmp");
        // macOS reports /tmp as a symlink to /private/tmp
        expect(r.output.trim()).toMatch(/^(\/private)?\/tmp$/);
    });

    test("abort kills it and reports no exit code", async () => {
        const ac = new AbortController();
        const started = Date.now();
        const p = runBangCommand("sleep 10", cwd, { signal: ac.signal });
        setTimeout(() => ac.abort(), 100);
        const r = await p;
        expect(r.exitCode).toBeNull();
        expect(Date.now() - started).toBeLessThan(3000);
    });

    test("streams output to onData as it arrives", async () => {
        const seen: string[] = [];
        await runBangCommand("echo a; echo b", cwd, { onData: (c) => seen.push(c) });
        expect(seen.join("")).toBe("a\nb\n");
    });

    test("caps runaway output and says so", async () => {
        const r = await runBangCommand("yes hello | head -c 400000", cwd);
        expect(r.truncated).toBe(true);
        // The HEAD is kept: the person who typed the command a second ago is
        // answered by its first lines, not its last.
        expect(r.output.startsWith("hello")).toBe(true);
        expect(r.output.length).toBeLessThanOrEqual(100_000);
    });
});

describe("formatBangContext", () => {
    test("frames it as the user's action, never as a tool call", async () => {
        const r = await runBangCommand("echo hi", cwd);
        const ctx = formatBangContext("echo hi", r);
        expect(ctx).toContain("The user ran a shell command");
        expect(ctx).toContain("not a tool call");
        expect(ctx).toContain("$ echo hi");
        expect(ctx).toContain("hi");
    });

    test("a clean run carries no status line to misread", async () => {
        const r = await runBangCommand("echo hi", cwd);
        expect(formatBangContext("echo hi", r)).not.toContain("exited with code");
    });

    test("a failure says so, so empty output is not mistaken for success", async () => {
        const r = await runBangCommand("exit 3", cwd);
        const ctx = formatBangContext("exit 3", r);
        expect(ctx).toContain("(no output)");
        expect(ctx).toContain("exited with code 3");
    });

    test("an interrupted run is named as interrupted", () => {
        const ctx = formatBangContext("sleep 10", { output: "", exitCode: null, truncated: false });
        expect(ctx).toContain("interrupted");
    });

    test("a command that could not start reports why", () => {
        const ctx = formatBangContext("x", { output: "", exitCode: null, spawnError: "ENOENT", truncated: false });
        expect(ctx).toContain("could not run: ENOENT");
        expect(ctx).not.toContain("interrupted");
    });

    test("truncation is disclosed to the model too", () => {
        const ctx = formatBangContext("yes", { output: "y\n", exitCode: 0, truncated: true });
        expect(ctx).toContain("truncated");
    });
});
