import { describe, expect, test } from "bun:test";
import {
    formatToolArgs,
    formatToolInvocation,
    readGutterPrefixes,
    readLineRangeText,
    taskPromptSnippet,
} from "../src/interactive/ui/tool-summary";

const CWD = "/repo";

describe("formatToolArgs", () => {
    test("file tools show a cwd-relative path", () => {
        expect(formatToolArgs("read", { path: "/repo/src/a.ts" }, CWD)).toBe("src/a.ts");
        expect(formatToolArgs("edit", { file_path: "/repo/src/b.ts" }, CWD)).toBe("src/b.ts");
        expect(formatToolArgs("ls", { path: "/repo" }, CWD)).toBe(".");
    });

    test("paths outside cwd are left absolute", () => {
        expect(formatToolArgs("read", { path: "/etc/hosts" }, CWD)).toBe("/etc/hosts");
    });

    test("bash shows the first line, at whatever length it is", () => {
        expect(formatToolArgs("bash", { command: "git status" }, CWD)).toBe("git status");
        expect(formatToolArgs("bash", { command: "echo one\necho two" }, CWD)).toBe("echo one");
        // It used to stop at 80 characters, which is a width nothing here
        // knows — the renderer fits the row to the terminal. See
        // shell-highlight.test.ts for the row that proves it.
        const long = "x".repeat(100);
        expect(formatToolArgs("bash", { command: long }, CWD)).toBe(long);
    });

    test("grep and find summarize their pattern", () => {
        expect(formatToolArgs("grep", { pattern: "TODO", path: "/repo/src" }, CWD)).toBe("TODO in src");
        expect(formatToolArgs("find", { pattern: "*.ts" }, CWD)).toBe("*.ts");
    });

    test("sql joins connection + collapsed query", () => {
        expect(formatToolArgs("sql", { connectionId: "prod", query: "select\n  1" }, CWD)).toBe("prod · select 1");
    });

    test("a pathological argument is still bounded — a guard, not a width", () => {
        // Nothing should carry a megabyte of one-liner through layout on every
        // frame; the ceiling sits far past any terminal, so it never clips.
        const huge = "y".repeat(4000);
        const summary = formatToolArgs("bash", { command: huge }, CWD);
        expect(summary.length).toBeLessThan(1100);
        expect(summary.endsWith("…")).toBe(true);
        expect(formatToolArgs("mystery", { blob: huge }, CWD).length).toBeLessThan(1100);
    });

    test("unknown tools fall back to JSON", () => {
        expect(formatToolArgs("mystery", { a: 1 }, CWD)).toBe('{"a":1}');
    });

    test("empty args yield an empty summary", () => {
        expect(formatToolArgs("read", {}, CWD)).toBe("");
    });
});

describe("taskPromptSnippet", () => {
    test("the first line, whole — the row decides where it ends", () => {
        const prompt = "a".repeat(120);
        expect(taskPromptSnippet({ prompt: `${prompt}\nsecond line` })).toBe(prompt);
        expect(taskPromptSnippet({})).toBe("");
    });

    test("still bounded against a pathological prompt", () => {
        expect(taskPromptSnippet({ prompt: "b".repeat(4000) }).length).toBeLessThan(1100);
    });
});

describe("readLineRangeText", () => {
    test("offset + limit → start-end", () => {
        expect(readLineRangeText({ offset: 10, limit: 5 })).toBe(":10-14");
    });
    test("offset only → :start", () => {
        expect(readLineRangeText({ offset: 20 })).toBe(":20");
    });
    test("neither → empty", () => {
        expect(readLineRangeText({})).toBe("");
    });
});

describe("formatToolInvocation", () => {
    test("prefixes the tool name", () => {
        expect(formatToolInvocation("read", { path: "/repo/x.ts" }, CWD)).toBe("read x.ts");
        expect(formatToolInvocation("bash", { command: "ls -la" }, CWD)).toBe("bash ls -la");
    });

    test("read appends its line range", () => {
        expect(formatToolInvocation("read", { path: "/repo/x.ts", offset: 10, limit: 5 }, CWD)).toBe("read x.ts:10-14");
    });

    test("task shows agent + prompt snippet", () => {
        expect(formatToolInvocation("task", { agent: "explore", prompt: "find the bug\nmore" }, CWD)).toBe(
            "task explore: find the bug",
        );
        expect(formatToolInvocation("task", { agent: "plan" }, CWD)).toBe("task plan");
    });

    test("a tool with no summarizable args is just its name", () => {
        expect(formatToolInvocation("read", {}, CWD)).toBe("read");
    });
});

describe("readGutterPrefixes", () => {
    test("numbers from line 1 when the read had no offset", () => {
        expect(readGutterPrefixes(["a", "b", "c"], {})).toEqual(["1  ", "2  ", "3  "]);
    });

    test("numbers from the offset, so previews match the file", () => {
        expect(readGutterPrefixes(["a", "b"], { offset: 120, limit: 2 })).toEqual(["120  ", "121  "]);
    });

    test("right-aligns to the widest number in the block", () => {
        const lines = Array.from({ length: 3 }, (_, i) => `l${i}`);
        expect(readGutterPrefixes(lines, { offset: 99 })).toEqual([" 99  ", "100  ", "101  "]);
    });

    test("the tool's trailing notice and its blank separator stay unnumbered", () => {
        const lines = ["a", "b", "", "[Showing lines 1-2 of 900. Use offset=3 to continue.]"];
        expect(readGutterPrefixes(lines, {})).toEqual(["1  ", "2  ", "", ""]);
    });

    test("a whole-result notice is a message, not a body", () => {
        expect(readGutterPrefixes(["[image file: image/png at /tmp/a.png]"], {})).toEqual([""]);
    });

    test("empty output numbers nothing", () => {
        expect(readGutterPrefixes([], { offset: 5 })).toEqual([]);
    });
});
