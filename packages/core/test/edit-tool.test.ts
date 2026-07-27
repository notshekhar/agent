import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEditsToNormalizedContent } from "../src/tools/utils/edit-diff";
import { createWriteTool } from "../src/tools/write";

describe("edit uniqueness", () => {
    // The file holds a curly-quote line and a straight-quote line. They are
    // distinct text, but fuzzy normalization folds them together.
    const mixed = `x("don’t")\nx("don't")\n`;

    test("an exactly-unique oldText is not rejected as ambiguous", () => {
        const { newContent } = applyEditsToNormalizedContent(
            mixed,
            [{ oldText: `x("don't")`, newText: `x("do")` }],
            "x.ts",
        );
        // The straight-quote line changed; the curly-quote line is untouched.
        expect(newContent).toBe(`x("don’t")\nx("do")\n`);
    });

    test("the curly-quote sibling is still individually addressable", () => {
        const { newContent } = applyEditsToNormalizedContent(
            mixed,
            [{ oldText: `x("don’t")`, newText: `x("do")` }],
            "x.ts",
        );
        expect(newContent).toBe(`x("do")\nx("don't")\n`);
    });

    test("genuinely duplicated text is still rejected", () => {
        expect(() => applyEditsToNormalizedContent(`a()\na()\n`, [{ oldText: "a()", newText: "b()" }], "x.ts")).toThrow(
            /Found 2 occurrences/,
        );
    });

    test("an ambiguous fuzzy-only match is still rejected", () => {
        // No exact match anywhere, and normalization leaves two candidates —
        // there is no anchor to prefer, so the model must add context.
        expect(() =>
            applyEditsToNormalizedContent(`x("a’b")\nx("a‘b")\n`, [{ oldText: `x("a'b")`, newText: "x()" }], "x.ts"),
        ).toThrow(/Found 2 occurrences/);
    });
});

describe("fuzzy edits leave the rest of the file alone", () => {
    // Every line here is something a fuzzy normalization pass would rewrite.
    const file = [
        `const msg = "don’t stop";`,
        "// costs 3—5 units",
        `const jp = "ｶﾀｶﾅ";`,
        "hard break line  ",
        "const target = 1;",
    ].join("\n");
    // Trailing space in oldText forces the match through the fuzzy path.
    const edits = [{ oldText: "const target = 1; ", newText: "const target = 2;" }];

    test("only the matched span changes", () => {
        const { newContent } = applyEditsToNormalizedContent(file, edits, "x.ts");
        expect(newContent).toBe(
            [
                `const msg = "don’t stop";`,
                "// costs 3—5 units",
                `const jp = "ｶﾀｶﾅ";`,
                "hard break line  ",
                "const target = 2;",
            ].join("\n"),
        );
    });

    test("smart quotes, dashes, half-width kana and hard breaks all survive", () => {
        const { newContent } = applyEditsToNormalizedContent(file, edits, "x.ts");
        const after = newContent.split("\n");
        expect(after[0]).toContain("’"); // not flattened to '
        expect(after[1]).toContain("—"); // not flattened to -
        expect(after[2]).toContain("ｶﾀｶﾅ"); // not NFKC-folded to full width
        expect(after[3]).toBe("hard break line  "); // markdown hard break intact
    });

    test("the diff is computed against the real file, so it shows the whole truth", () => {
        const { baseContent } = applyEditsToNormalizedContent(file, edits, "x.ts");
        // A diff taken against a normalized copy would hide the collateral edits.
        expect(baseContent).toBe(file);
    });

    test("a fuzzy match still replaces the right span", () => {
        // oldText differs from the file only by a curly apostrophe.
        const { newContent } = applyEditsToNormalizedContent(
            `a = 1;\nconst msg = "don't stop";\nb = 2;`,
            [{ oldText: `const msg = "don’t stop";`, newText: "const msg = OK;" }],
            "x.ts",
        );
        expect(newContent).toBe("a = 1;\nconst msg = OK;\nb = 2;");
    });
});

describe("write byte reporting", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-write-"));
    const write = createWriteTool({ cwd: dir, sessionId: "write-tests" });
    const exec = (input: unknown) =>
        (write as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, {} as never);

    test("reports the file's real byte length, not its character count", async () => {
        const content = "héllo → ünïcode";
        const out = await exec({ path: "unicode.txt", content });
        const onDisk = readFileSync(join(dir, "unicode.txt")).byteLength;
        expect(onDisk).toBe(20);
        expect(content.length).toBe(15); // the count that used to be reported
        expect(out).toBe(`Successfully wrote ${onDisk} bytes to unicode.txt`);
    });

    test("ascii content is unaffected", async () => {
        const out = await exec({ path: "ascii.txt", content: "hello" });
        expect(out).toBe("Successfully wrote 5 bytes to ascii.txt");
    });

    test("an existing file still needs a full read first", async () => {
        writeFileSync(join(dir, "existing.txt"), "old");
        await expect(exec({ path: "existing.txt", content: "new" })).rejects.toThrow(/has not been read/);
    });
});
