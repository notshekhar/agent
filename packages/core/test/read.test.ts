import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "../src/tools/read";
import { LARGE_FILE_BYTES, selectLines, type LineSelection } from "../src/tools/utils/read-file-lines";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/tools/utils/truncate";

const dir = mkdtempSync(join(tmpdir(), "loop-read-"));
const read = createReadTool({ cwd: dir, sessionId: "read-tests" });
const opts = {} as never;
const exec = (input: { path: string; offset?: number; limit?: number }) =>
    (read as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, opts);

function write(name: string, content: string | Buffer): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
}

/** Follow the tool's own "use offset=N to continue" hints to the end. */
async function paginate(name: string): Promise<string[]> {
    const pages: string[] = [];
    let offset: number | undefined;
    for (;;) {
        const out = await exec({ path: name, ...(offset ? { offset } : {}) });
        const match = out.match(/Use offset=(\d+) to continue/);
        pages.push(match ? out.slice(0, out.lastIndexOf("\n\n[")) : out);
        if (!match) return pages;
        offset = Number(match[1]);
    }
}

describe("read line counting", () => {
    const tenLines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n") + "\n";

    test("a file's final newline doesn't add a phantom line", async () => {
        write("ten.txt", tenLines);
        // 10 lines, not 11: 5 shown, 5 left.
        expect(await exec({ path: "ten.txt", limit: 5 })).toBe(
            "L1\nL2\nL3\nL4\nL5\n\n[5 more lines in file. Use offset=6 to continue.]",
        );
    });

    test("a limited read that lands on the last line has no continuation hint", async () => {
        write("ten.txt", tenLines);
        expect(await exec({ path: "ten.txt", offset: 6, limit: 5 })).toBe("L6\nL7\nL8\nL9\nL10\n");
        expect(await exec({ path: "ten.txt", offset: 6, limit: 99 })).toBe("L6\nL7\nL8\nL9\nL10\n");
    });

    test("offset past the last line reports the real total", async () => {
        write("ten.txt", tenLines);
        expect(await exec({ path: "ten.txt", offset: 10 })).toBe("L10\n");
        await expect(exec({ path: "ten.txt", offset: 11 })).rejects.toThrow(
            "Offset 11 is beyond end of file (10 lines total)",
        );
    });

    test("a file without a trailing newline keeps its exact shape", async () => {
        write("bare.txt", "a\nb\nc");
        expect(await exec({ path: "bare.txt" })).toBe("a\nb\nc");
    });

    test("singular wording for one remaining line", async () => {
        write("three.txt", "a\nb\nc\n");
        expect(await exec({ path: "three.txt", limit: 2 })).toContain("[1 more line in file.");
    });

    test("empty file reads as empty", async () => {
        write("empty.txt", "");
        expect(await exec({ path: "empty.txt" })).toBe("");
    });

    test("CRLF line endings survive", async () => {
        write("crlf.txt", "a\r\nb\r\nc\r\n");
        expect(await exec({ path: "crlf.txt", limit: 2 })).toBe(
            "a\r\nb\r\n\n[1 more line in file. Use offset=3 to continue.]",
        );
    });
});

describe("read truncation", () => {
    test("line-limit pages resume with no gap or overlap", async () => {
        const total = DEFAULT_MAX_LINES + 500;
        write("lines.txt", Array.from({ length: total }, (_, i) => `${i + 1}`).join("\n") + "\n");
        const pages = await paginate("lines.txt");
        expect(pages.length).toBe(2);
        expect(pages[0].split("\n").at(-1)).toBe(String(DEFAULT_MAX_LINES));
        expect(pages[1].split("\n")[0]).toBe(String(DEFAULT_MAX_LINES + 1));
        // every line exactly once, in order
        expect(pages.join("\n").trim().split("\n")).toEqual(Array.from({ length: total }, (_, i) => String(i + 1)));
    });

    test("byte-limit pages resume with no gap or overlap", async () => {
        const total = 500;
        write("wide.txt", Array.from({ length: total }, (_, i) => `${i + 1}:${"x".repeat(300)}`).join("\n") + "\n");
        const pages = await paginate("wide.txt");
        expect(pages.length).toBeGreaterThan(1);
        const seen = pages
            .join("\n")
            .split("\n")
            .filter(Boolean)
            .map((l) => Number(l.split(":")[0]));
        expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    });

    test("a single line over the byte limit reports its size and stays skippable", async () => {
        write("long.txt", `${"A".repeat(DEFAULT_MAX_BYTES + 1024)}\nsecond\n`);
        const out = await exec({ path: "long.txt" });
        expect(out).toContain("[Line 1 is 51.0KB, exceeds 50.0KB limit.");
        expect(out).toContain("sed -n '1p'");
        expect(await exec({ path: "long.txt", offset: 2 })).toBe("second\n");
    });

    test("paths with spaces are quoted in the bash hint", async () => {
        write("has space.txt", `${"A".repeat(DEFAULT_MAX_BYTES + 10)}\n`);
        expect(await exec({ path: "has space.txt" })).toContain(`sed -n '1p' 'has space.txt'`);
    });
});

describe("read non-text inputs", () => {
    test("a directory says so instead of leaking EISDIR", async () => {
        mkdirSync(join(dir, "adir"), { recursive: true });
        await expect(exec({ path: "adir" })).rejects.toThrow(/is a directory, not a file/);
    });

    test("a binary file is described, not dumped", async () => {
        write("blob.bin", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0xff, 0xfe, 0x00]));
        const out = await exec({ path: "blob.bin" });
        expect(out).toContain("[binary file:");
        expect(out).not.toContain("\u0000"); // no NUL bytes into the transcript
        expect(out).not.toContain("\ufffd"); // and no mojibake
    });

    test("text with high-bit characters is still text", async () => {
        write("utf8.txt", "héllo — ünicode\n日本語\n");
        expect(await exec({ path: "utf8.txt" })).toBe("héllo — ünicode\n日本語\n");
    });
});

describe("read streaming path (large files)", () => {
    // Forcing `size` past the threshold exercises the streaming reader without
    // writing a multi-megabyte fixture.
    const streamed = (path: string, o: { offset?: number; limit?: number } = {}) =>
        selectLines(path, { ...o, size: LARGE_FILE_BYTES + 1 });
    const buffered = (path: string, o: { offset?: number; limit?: number } = {}) =>
        selectLines(path, { ...o, size: statSync(path).size });

    /** Everything except totalLines, which a streamed read only learns at EOF. */
    const shape = ({ lines, startLine, truncatedBy, hasMore, trailingNewline, firstLineBytes }: LineSelection) => ({
        lines,
        startLine,
        truncatedBy,
        hasMore,
        trailingNewline,
        firstLineBytes,
    });

    test("streamed and buffered selections agree", async () => {
        const path = write("parity.txt", Array.from({ length: 300 }, (_, i) => `row ${i + 1}`).join("\n") + "\n");
        for (const o of [{}, { offset: 5 }, { offset: 5, limit: 10 }, { offset: 300 }, { limit: 1 }]) {
            expect(shape(await streamed(path, o))).toEqual(shape(await buffered(path, o)));
        }
    });

    test("a streamed read that reaches EOF still knows the total", async () => {
        const path = write("parity3.txt", Array.from({ length: 300 }, (_, i) => `row ${i + 1}`).join("\n") + "\n");
        expect((await streamed(path)).totalLines).toBe(300);
        // but one stopped by a limit reports no total, so the tool says "more lines" without a count
        expect((await streamed(path, { limit: 10 })).totalLines).toBeUndefined();
    });

    test("streamed and buffered agree without a trailing newline", async () => {
        const path = write("parity2.txt", Array.from({ length: 50 }, (_, i) => `row ${i + 1}`).join("\n"));
        expect(await streamed(path)).toEqual(await buffered(path));
        expect((await streamed(path)).trailingNewline).toBe(false);
    });

    test("streaming reports a real total only when it reaches the end", async () => {
        const path = write("tail.txt", Array.from({ length: DEFAULT_MAX_LINES + 10 }, (_, i) => `${i + 1}`).join("\n"));
        expect((await streamed(path)).totalLines).toBeUndefined(); // truncated before EOF
        expect((await streamed(path, { offset: DEFAULT_MAX_LINES + 1 })).totalLines).toBe(DEFAULT_MAX_LINES + 10);
    });

    test("streaming rejects an offset past the end", async () => {
        const path = write("short.txt", "a\nb\n");
        await expect(streamed(path, { offset: 3 })).rejects.toThrow("Offset 3 is beyond end of file (2 lines total)");
    });

    test("a single line larger than the budget is clipped, not buffered", async () => {
        const path = write("oneline.txt", "z".repeat(DEFAULT_MAX_BYTES * 3));
        const selection = await streamed(path);
        expect(selection.lines).toEqual([]);
        expect(selection.firstLineClipped).toBe(true);
        expect(selection.firstLineBytes).toBeGreaterThan(DEFAULT_MAX_BYTES);
        // the tool itself buffers a file this small, and still refuses the line
        expect(await exec({ path: "oneline.txt" })).toContain("exceeds 50.0KB limit");
    });
});
