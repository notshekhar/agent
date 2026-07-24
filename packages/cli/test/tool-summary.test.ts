import { describe, expect, test } from "bun:test";
import {
    formatToolArgs,
    formatToolInvocation,
    readGutterPrefixes,
    readLineRangeText,
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

    test("bash shows the first line, truncated", () => {
        expect(formatToolArgs("bash", { command: "git status" }, CWD)).toBe("git status");
        expect(formatToolArgs("bash", { command: "echo one\necho two" }, CWD)).toBe("echo one");
        const long = "x".repeat(100);
        expect(formatToolArgs("bash", { command: long }, CWD)).toBe(`${"x".repeat(77)}…`);
    });

    test("grep and find summarize their pattern", () => {
        expect(formatToolArgs("grep", { pattern: "TODO", path: "/repo/src" }, CWD)).toBe("TODO in src");
        expect(formatToolArgs("find", { pattern: "*.ts" }, CWD)).toBe("*.ts");
    });

    test("sql joins connection + collapsed query", () => {
        expect(formatToolArgs("sql", { connectionId: "prod", query: "select\n  1" }, CWD)).toBe("prod · select 1");
    });

    test("unknown tools fall back to truncated JSON", () => {
        expect(formatToolArgs("mystery", { a: 1 }, CWD)).toBe('{"a":1}');
    });

    test("empty args yield an empty summary", () => {
        expect(formatToolArgs("read", {}, CWD)).toBe("");
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
