import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createFindTool } from "../src/tools/find";
import { createGrepTool } from "../src/tools/grep";
import { createLsTool } from "../src/tools/ls";
import { getToolPath } from "../src/tools/utils/tools-manager";

const opts = {} as never;
type Exec = { execute: (i: unknown, o: unknown) => Promise<string> };
const exec = (tool: unknown, input: unknown) => (tool as Exec).execute(input, opts);

// grep/find shell out to rg/fd. Use them only when they're already installed —
// a test must never trigger the download path.
const hasRg = getToolPath("rg") !== null;
const hasFd = getToolPath("fd") !== null;

function scratch(prefix: string): string {
    return mkdtempSync(join(tmpdir(), `loop-${prefix}-`));
}

describe("grep context blocks", () => {
    const dir = scratch("grep");
    const grep = createGrepTool({ cwd: dir });
    writeFileSync(join(dir, "a.txt"), ["one", "two match", "three", "four match", "five", "six"].join("\n") + "\n");
    writeFileSync(join(dir, "far.txt"), ["hit here", ...Array(10).fill("filler"), "hit again"].join("\n") + "\n");

    test.skipIf(!hasRg)("merges overlapping windows instead of repeating shared lines", async () => {
        // Matches on lines 2 and 4 with context 2: the windows (1-4, 2-6)
        // overlap, so they render as one run and line 4 stays a match line.
        expect(await exec(grep, { pattern: "match", path: dir, context: 2 })).toBe(
            [
                "a.txt-1- one",
                "a.txt:2: two match",
                "a.txt-3- three",
                "a.txt:4: four match",
                "a.txt-5- five",
                "a.txt-6- six",
            ].join("\n"),
        );
    });

    test.skipIf(!hasRg)("separates non-adjacent runs with --", async () => {
        const out = await exec(grep, { pattern: "hit", path: join(dir, "far.txt"), context: 1 });
        expect(out).toBe(
            ["far.txt:1: hit here", "far.txt-2- filler", "--", "far.txt-11- filler", "far.txt:12: hit again"].join(
                "\n",
            ),
        );
    });

    test.skipIf(!hasRg)("context past the last line doesn't invent a trailing blank", async () => {
        // far.txt ends with a newline; that terminates line 12 rather than
        // starting an empty line 13.
        const out = await exec(grep, { pattern: "hit again", path: join(dir, "far.txt"), context: 2 });
        expect(out.split("\n").at(-1)).toBe("far.txt:12: hit again");
    });

    test.skipIf(!hasRg)("no line is emitted twice", async () => {
        const out = await exec(grep, { pattern: "match", path: dir, context: 3 });
        const lineNumbers = out.split("\n").map((l) => l.match(/[:-](\d+)[:-]/)?.[1]);
        expect(new Set(lineNumbers).size).toBe(lineNumbers.length);
    });

    test.skipIf(!hasRg)("without context, only matching lines come back", async () => {
        expect(await exec(grep, { pattern: "match", path: dir })).toBe("a.txt:2: two match\na.txt:4: four match");
    });
});

describe("find path relativization", () => {
    const dir = scratch("find");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "nested", "deep.txt"), "x");
    const find = createFindTool({ cwd: dir });

    test.skipIf(!hasFd)("returns paths relative to the search directory", async () => {
        expect(await exec(find, { pattern: "deep.txt", path: dir })).toBe(join("nested", "deep.txt"));
    });

    test.skipIf(!hasFd)("a search root that already ends in a separator keeps the first character", async () => {
        // The root of the filesystem ends in a separator, so slicing
        // `length + 1` used to eat a real character off every result.
        const out = await exec(find, { pattern: "deep.txt", path: dir + sep });
        expect(out).toBe(join("nested", "deep.txt"));
        expect(out.startsWith("ested")).toBe(false);
    });
});

describe("ls entries that cannot be stat'd", () => {
    const dir = scratch("ls");
    const ls = createLsTool({ cwd: dir });
    writeFileSync(join(dir, "real.txt"), "hi");
    mkdirSync(join(dir, "sub"));
    symlinkSync(join(dir, "definitely-not-here"), join(dir, "broken-link"));

    test("a broken symlink is listed and marked, never dropped", async () => {
        // stat follows the link and throws; the entry still exists and hiding
        // it reads to the agent as "this file is not there".
        expect(await exec(ls, { path: dir })).toBe("broken-link@\nreal.txt\nsub/");
    });
});
