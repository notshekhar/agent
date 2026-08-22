/**
 * The full-output temp file is a nicety; losing it must never cost more than
 * itself. These tests pin the two ways it used to cost the whole process.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputAccumulator } from "../src/tools/utils/output-accumulator";

/** Small budgets so a couple of short lines trip truncation. */
const TINY = { maxLines: 2, maxBytes: 16 };

/**
 * A prefix under a directory that does not exist. The accumulator joins the
 * prefix onto `tmpdir()`, so every open fails with ENOENT — the cheap stand-in
 * for the unwritable TMPDIR / full disk this file is about.
 */
const UNWRITABLE = "nonexistent-dir-for-loop-tests/probe";

function line(text: string): Buffer {
    return Buffer.from(`${text}\n`);
}

describe("OutputAccumulator temp file", () => {
    test("persists the full output when the temp file is writable", async () => {
        const acc = new OutputAccumulator({ ...TINY, tempFilePrefix: "loop-test-ok" });
        for (const n of [1, 2, 3, 4]) acc.append(line(`line ${n}`));
        acc.finish();

        const snap = acc.snapshot({ persistIfTruncated: true });
        await acc.closeTempFile();

        expect(snap.truncation.truncated).toBe(true);
        expect(snap.fullOutputPath).toBeDefined();
        expect(readFileSync(snap.fullOutputPath!, "utf-8")).toBe("line 1\nline 2\nline 3\nline 4\n");
    });

    test("an unwritable temp file never raises an unhandled 'error' event", async () => {
        // The regression: createWriteStream's failure is asynchronous, so with
        // no 'error' listener it surfaced as an unhandled error event — fatal
        // in print mode / RPC, which install no process-level handler.
        const unhandled: unknown[] = [];
        const onUncaught = (err: unknown) => unhandled.push(err);
        process.on("uncaughtException", onUncaught);
        process.on("unhandledRejection", onUncaught);
        try {
            const acc = new OutputAccumulator({ ...TINY, tempFilePrefix: UNWRITABLE });
            for (const n of [1, 2, 3, 4]) acc.append(line(`line ${n}`));
            // Let the failed open land, then keep streaming across it — output
            // does not stop arriving just because the scratch copy is gone.
            await new Promise((resolve) => setTimeout(resolve, 50));
            acc.append(line("line 5"));
            acc.finish();
            await acc.closeTempFile();
        } finally {
            process.off("uncaughtException", onUncaught);
            process.off("unhandledRejection", onUncaught);
        }
        expect(unhandled).toEqual([]);
    });

    test("closeTempFile settles instead of hanging once the stream has failed", async () => {
        // `end()` on a stream Node already destroyed emits no 'finish', so
        // awaiting that alone waited forever — and the bash tool awaits this
        // before it can return.
        const acc = new OutputAccumulator({ ...TINY, tempFilePrefix: UNWRITABLE });
        for (const n of [1, 2, 3, 4]) acc.append(line(`line ${n}`));
        acc.finish();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const settled = await Promise.race([
            acc.closeTempFile().then(() => "settled"),
            new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
        ]);
        expect(settled).toBe("settled");
    });

    test("a failed temp file still reports the output, with no path to a file that was never written", async () => {
        const acc = new OutputAccumulator({ ...TINY, tempFilePrefix: UNWRITABLE });
        for (const n of [1, 2, 3, 4]) acc.append(line(`line ${n}`));
        acc.finish();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const snap = acc.snapshot({ persistIfTruncated: true });
        await acc.closeTempFile();

        // The tail — what the command actually printed — survives.
        expect(snap.content).toContain("line 4");
        expect(snap.truncation.truncated).toBe(true);
        // 4 newline-terminated lines plus the empty current line after the last
        // one — the class counts newlines from a starting line of 1.
        expect(snap.truncation.totalLines).toBe(5);
        // But nothing points at the file that could not be written.
        expect(snap.fullOutputPath).toBeUndefined();
    });

    test("a failed temp file stops buffering raw chunks", async () => {
        // Falling back to `rawChunks` after the file is gone would hold every
        // byte of a multi-GB command in memory, waiting on a flush that can
        // never come. Asserted on the buffer itself rather than on heapUsed:
        // this is the actual invariant, and a heap measurement of it is at the
        // mercy of when GC happens to run.
        const acc = new OutputAccumulator({ ...TINY, tempFilePrefix: UNWRITABLE });
        const buffered = () => (acc as unknown as { rawChunks: Buffer[] }).rawChunks.length;

        acc.append(line("line 1"));
        acc.append(line("line 2"));
        await new Promise((resolve) => setTimeout(resolve, 50));

        const chunk = Buffer.alloc(1024 * 1024, 0x61); // 1MB of "a"
        for (let i = 0; i < 32; i++) acc.append(chunk);
        acc.finish();

        expect(buffered()).toBe(0);
        // And the decoded tail stayed bounded rather than growing with input.
        expect(acc.snapshot().content.length).toBeLessThanOrEqual(TINY.maxBytes);
        await acc.closeTempFile();
    });

    test("does not create the directory it failed to write into", async () => {
        // The prefix is resolved under tmpdir(), so this is the directory the
        // failed opens actually targeted.
        const targetDir = join(tmpdir(), "nonexistent-dir-for-loop-tests");
        expect(existsSync(targetDir)).toBe(false);

        const acc = new OutputAccumulator({ ...TINY, tempFilePrefix: UNWRITABLE });
        for (const n of [1, 2, 3]) acc.append(line(`line ${n}`));
        acc.finish();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await acc.closeTempFile();

        expect(existsSync(targetDir)).toBe(false);
    });
});
