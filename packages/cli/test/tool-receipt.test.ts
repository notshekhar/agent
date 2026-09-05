import { describe, expect, test } from "bun:test";
import { formatToolReceipt, toolPeek } from "../src/interactive/ui/tool-receipt";

/** `formatToolReceipt`, with the two arguments that are usually empty defaulted. */
const receipt = (tool: string, output: string, args: Record<string, unknown> = {}, isError = false) =>
    formatToolReceipt(tool, args, output, isError);

describe("tool receipts", () => {
    test("an empty result is silence, except where emptiness is the news", () => {
        // a command that printed nothing still ran; an empty file was still read
        expect(receipt("bash", "   \n  ")).toBe("ok · no output");
        expect(receipt("read", "")).toBe("empty file");
        expect(receipt("grep", "")).toBe("");
        expect(receipt("sentry__get_error", "")).toBe("");
    });

    describe("read", () => {
        test("counts the body of a whole-file read", () => {
            expect(receipt("read", "a\nb\nc")).toBe("3 lines");
            expect(receipt("read", "only")).toBe("1 line");
        });

        test("a trailing newline is not an extra line", () => {
            expect(receipt("read", "a\nb\n")).toBe("2 lines");
        });

        test("the truncation notice becomes the range, and is not counted as body", () => {
            const out = "a\nb\nc\n\n[Showing lines 1-3 of 900. Use offset=4 to continue.]";
            expect(receipt("read", out)).toBe("lines 1–3 of 900");
        });

        test("a `N more lines` notice reports the part against the whole", () => {
            const out = "a\nb\n\n[7 more lines in file. Use offset=3 to continue.]";
            expect(receipt("read", out)).toBe("2 of 9 lines");
        });

        test("a whole-result notice IS the answer, cut before its advice", () => {
            const bin = "[binary file: 4.2 KB at /repo/a.bin. Not printed as text; inspect it with bash]";
            expect(receipt("read", bin)).toBe("binary file: 4.2 KB");
            const img = "[image file: image/png at /repo/a.png. Image rendering not supported in this tool result]";
            expect(receipt("read", img)).toBe("image file: image/png");
            const long = "[Line 5 is over 256 KB, exceeds 256 KB limit. Use bash: sed -n '5p' a.ts]";
            expect(receipt("read", long)).toBe("Line 5 is over 256 KB, exceeds 256 KB limit");
        });

        test("an offset read reports a range only when the file ended early", () => {
            // ends where it was asked to — the row's `:120-122` already says so
            expect(receipt("read", "a\nb\nc", { offset: 120, limit: 3 })).toBe("3 lines");
            // ended early: the range is news the title cannot carry
            expect(receipt("read", "a\nb", { offset: 120, limit: 50 })).toBe("lines 120–121");
        });
    });

    describe("bash", () => {
        test("a clean run reports ok and its size", () => {
            expect(receipt("bash", "1\n2\n3")).toBe("ok · 3 lines");
        });

        test("the exit code is the news, and its status line is not output", () => {
            const out = "14 pass\n3 fail\n\nCommand exited with code 1";
            expect(receipt("bash", out, {}, true)).toBe("exit 1 · 2 lines");
        });

        test("aborted and timed-out runs say so", () => {
            expect(receipt("bash", "partial\n\nCommand aborted", {}, true)).toBe("aborted · 1 line");
            expect(receipt("bash", "x\n\nCommand timed out after 120 seconds", {}, true)).toBe("timed out 120s · 1 line");
        });

        test("a failure with no exit code never claims ok", () => {
            expect(receipt("bash", "spawn failed", {}, true)).toBe("failed · 1 line");
        });

        test("a backgrounded command is named by its shell, not its output", () => {
            const out =
                'Started sh_3 in the background (pid 4111).\nRead its output with shells({ action: "output", id: "sh_3" }).';
            expect(receipt("bash", out)).toBe("background sh_3");
        });

        test("a promoted command reports the shell it became", () => {
            const out =
                'Still running after 120s, so it was moved to the background as sh_7 (pid 9).\nRead it with shells({ action: "output", id: "sh_7" }).';
            expect(receipt("bash", out)).toBe("background sh_7");
        });

        test("a command that printed nothing says so rather than `0 lines`", () => {
            expect(receipt("bash", "\n\nCommand exited with code 2", {}, true)).toBe("exit 2 · no output");
        });
    });

    describe("edit and write", () => {
        // generateDiffString emits `+`/`-`/` ` then a padded line number.
        const diff = ["-42 const a = 1", "+42 const a = 2", "+43 const b = 3", " 44 ctx"].join("\n");

        test("edit counts the diff and names its blocks", () => {
            const out = `Successfully replaced 2 block(s) in a.ts.\n\n${diff}`;
            expect(receipt("edit", out, { edits: [{}, {}] })).toBe("+2 −1 · 2 blocks");
        });

        test("a single block does not spell out the count", () => {
            const out = `Successfully replaced 1 block(s) in a.ts.\n\n${diff}`;
            expect(receipt("edit", out, { edits: [{}] })).toBe("+2 −1");
        });

        test("a replayed edit whose diff never persisted falls back to blocks", () => {
            // The real diff rides the live tool-result event and exists nowhere
            // else — inventing `+0 −0` here would be a lie the transcript keeps.
            expect(receipt("edit", "Successfully replaced 2 block(s) in a.ts.", { edits: [{}, {}] })).toBe("2 blocks");
        });

        test("write reports a new file by the content it was given", () => {
            expect(receipt("write", "Successfully wrote 84 bytes to a.ts", { content: "a\nb\nc" })).toBe("new · 3 lines");
        });

        test("write reports an overwrite as a diff", () => {
            const out = `Successfully wrote 84 bytes to a.ts\n\n${diff}`;
            expect(receipt("write", out, { content: "x" })).toBe("+2 −1");
        });

        test("an unchanged overwrite says so", () => {
            expect(receipt("write", "Successfully wrote 4 bytes to a.ts (content unchanged)", { content: "x" })).toBe(
                "unchanged",
            );
        });
    });

    describe("searches and listings", () => {
        test("grep counts matches and the files they came from", () => {
            const out = ["src/a.ts:12: hit", "src/a.ts:40: hit", "src/b.ts:3: hit"].join("\n");
            expect(receipt("grep", out)).toBe("3 matches · 2 files");
        });

        test("grep's own notice is not a match", () => {
            const out = "src/a.ts:12: hit\n\n[100 matches limit reached. Use limit=200 for more]";
            expect(receipt("grep", out)).toBe("1 match · 1 file");
        });

        test("empty results are named, not counted", () => {
            expect(receipt("grep", "No matches found")).toBe("no matches");
            expect(receipt("find", "No files found matching pattern")).toBe("no matches");
            expect(receipt("ls", "(empty directory)")).toBe("empty");
        });

        test("find counts files and ls counts entries", () => {
            expect(receipt("find", "a.ts\nb.ts")).toBe("2 files");
            expect(receipt("ls", "src/\npkg/\na.ts")).toBe("3 entries");
        });

        test("sql reports rows rather than the JSON's lines", () => {
            expect(receipt("sql", '2 row(s):\n[\n  { "a": 1 },\n  { "a": 2 }\n]')).toBe("2 rows");
            expect(receipt("sql", "(0 rows)")).toBe("0 rows");
        });

        test("websearch counts its numbered results", () => {
            const out = "1. First\n   https://a\n   snip\n2. Second\n   https://b";
            expect(receipt("websearch", out)).toBe("2 results");
        });
    });

    describe("failures and unknown tools", () => {
        test("a one-line failure IS its message", () => {
            expect(receipt("read", "File not found: /repo/nope.ts", {}, true)).toBe("File not found: /repo/nope.ts");
        });

        test("a long one-line failure is clipped, never wrapped", () => {
            const long = `File not found: ${"x".repeat(200)}`;
            const out = receipt("read", long, {}, true);
            expect(out.length).toBeLessThanOrEqual(44);
            expect(out.endsWith("…")).toBe(true);
        });

        test("a multi-line failure is counted, because its text needs the expand", () => {
            expect(receipt("grep", "boom\nat frame 1\nat frame 2", {}, true)).toBe("failed · 3 lines");
        });

        test("somebody else's tool gets the only thing we know", () => {
            expect(receipt("sentry__get_error", "a\nb")).toBe("2 lines");
        });
    });
});

describe("tool peeks", () => {
    const peek = (tool: string, output: string, isError = false, max = 3, args: Record<string, unknown> = {}) =>
        toolPeek(tool, output, isError, max, args);

    const ten = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n");

    test("a command peeks its TAIL — the verdict, not the preamble", () => {
        expect(peek("bash", ten)).toEqual({ lines: ["L8", "L9", "L10"], hidden: 7 });
    });

    test("bash's own status line is not part of the peek", () => {
        const out = "14 pass\n3 fail\nFAIL a.test.ts\n\nCommand exited with code 1";
        expect(peek("bash", out, true).lines).toEqual(["14 pass", "3 fail", "FAIL a.test.ts"]);
    });

    test("a search peeks its HEAD — the ordering is the answer", () => {
        expect(peek("grep", ten)).toEqual({ lines: ["L1", "L2", "L3"], hidden: 7 });
        expect(peek("ls", ten).lines).toEqual(["L1", "L2", "L3"]);
    });

    test("a read peeks nothing — you named the file, the receipt sized it", () => {
        expect(peek("read", ten)).toEqual({ lines: [], hidden: 0 });
    });

    test("a failure peeks its tail whatever the tool", () => {
        // grep would normally peek its head; an error ends with what went wrong
        expect(peek("grep", ten, true).lines).toEqual(["L8", "L9", "L10"]);
        expect(peek("read", ten, true).lines).toEqual(["L8", "L9", "L10"]);
    });

    test("an edit peeks the changed lines, skipping context", () => {
        const out = [
            "Successfully replaced 1 block(s) in a.ts.",
            "",
            " 40 import x",
            "-42 const a = 1",
            "+42 const a = 2",
            " 43 ctx",
            "+44 const b = 3",
        ].join("\n");
        expect(peek("edit", out).lines).toEqual(["-42 const a = 1", "+42 const a = 2", "+44 const b = 3"]);
    });

    test("a new file's write peeks the content it wrote", () => {
        // There is no diff to hunk over, and the result text never carries the
        // content — only the argument does.
        const got = peek("write", "Successfully wrote 9 bytes to a.ts", false, 3, { content: "a\nb\nc\nd\ne" });
        expect(got).toEqual({ lines: ["a", "b", "c"], hidden: 2 });
    });

    test("a replayed edit with no diff and no content peeks nothing", () => {
        expect(peek("edit", "Successfully replaced 2 block(s) in a.ts.")).toEqual({ lines: [], hidden: 0 });
    });

    test("output shorter than the budget is shown whole, with nothing hidden", () => {
        expect(peek("bash", "one\ntwo")).toEqual({ lines: ["one", "two"], hidden: 0 });
    });

    test("leading and trailing blanks are dropped, interior ones kept", () => {
        expect(peek("grep", "\n\na\n\nb\n\n", false, 5).lines).toEqual(["a", "", "b"]);
    });

    test("a zero budget disables the peek entirely", () => {
        expect(peek("bash", ten, false, 0)).toEqual({ lines: [], hidden: 0 });
    });

    test("an unknown tool peeks its head, like the MCP kind it falls into", () => {
        expect(peek("sentry__get_error", ten).lines).toEqual(["L1", "L2", "L3"]);
    });

    test("a subagent peeks the end of its run log", () => {
        expect(peek("task", ten).lines).toEqual(["L8", "L9", "L10"]);
    });
});

describe("ask", () => {
    // formatAskAnswers (core/tools/ask.ts) writes the shapes asserted here.
    const one = 'User answers:\n\n[Approach] Which way?\n→ Rewrite the parser';
    const withNote = `${one}\n→ user note: "keep the old one around"`;
    const many =
        "User answers:\n\n[Approach] Which way?\n→ Rewrite\n\n[Scope] How far?\n→ Just the parser\n\n[When] Now?\n→ Later";

    test("a single answer IS the receipt — it is what you scroll back for", () => {
        expect(receipt("ask", one)).toBe("answered · Rewrite the parser");
    });

    test("a note does not become a second answer", () => {
        expect(receipt("ask", withNote)).toBe("answered · Rewrite the parser");
    });

    test("several answers are counted — three on one line is unreadable", () => {
        expect(receipt("ask", many)).toBe("answered · 3 questions");
    });

    test("a custom answer loses its label and its quotes", () => {
        const custom = 'User answers:\n\n[Approach] Which way?\n→ (custom answer) "do both"';
        expect(receipt("ask", custom)).toBe("answered · do both");
    });

    test("declining is its own outcome, not an answer", () => {
        expect(receipt("ask", "The user declined to answer. Proceed with your best judgment.")).toBe("declined");
    });

    test("a long answer is clipped to fit the row", () => {
        const long = `User answers:\n\n[X] Which?\n→ ${"y".repeat(80)}`;
        expect(receipt("ask", long).length).toBeLessThanOrEqual(44);
    });
});
