import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "../src/tools/read";
import { createWriteTool } from "../src/tools/write";

const dir = mkdtempSync(join(tmpdir(), "loop-write-diff-"));
const ctx = { cwd: dir };
const read = createReadTool(ctx);
const write = createWriteTool(ctx);
const opts = {} as never;

const exec = <T>(t: { execute?: unknown }, input: T) =>
    (t.execute as (i: T, o: unknown) => Promise<unknown>)(input, opts);

/** What the model is actually told, as the AI SDK would compute it. */
const modelOutput = async (output: unknown): Promise<string> => {
    const toModelOutput = (write as { toModelOutput?: (o: { output: unknown }) => { value: string } })
        .toModelOutput;
    if (!toModelOutput) throw new Error("write tool defines no toModelOutput");
    return toModelOutput({ output }).value;
};

describe("write diff reporting", () => {
    test("a new file reports no diff — its content is already the call's input", async () => {
        const out = String(await exec(write, { path: "new.txt", content: "alpha\nbeta\n" }));
        expect(out).toContain("Successfully wrote");
        expect(out).not.toContain("\n+");
    });

    test("an overwrite reports a diff of what actually changed", async () => {
        writeFileSync(join(dir, "over.txt"), "one\ntwo\nthree\n");
        await exec(read, { path: "over.txt" });
        const out = String(await exec(write, { path: "over.txt", content: "one\nTWO\nthree\n" }));
        expect(out).toContain("+");
        expect(out).toContain("TWO");
        expect(out).toContain("-");
        // Unchanged neighbours ride along as diff context, not as changes.
        expect(out).not.toMatch(/^[+-]\s*\d+ one$/m);
    });

    test("an overwrite that changes nothing says so instead of faking a diff", async () => {
        writeFileSync(join(dir, "same.txt"), "identical\n");
        await exec(read, { path: "same.txt" });
        const out = String(await exec(write, { path: "same.txt", content: "identical\n" }));
        expect(out).toContain("(content unchanged)");
        expect(out).not.toContain("\n+");
    });

    test("the diff never reaches the model", async () => {
        writeFileSync(join(dir, "hidden.txt"), "before\n");
        await exec(read, { path: "hidden.txt" });
        const raw = await exec(write, { path: "hidden.txt", content: "after\n" });
        expect(String(raw)).toContain("after");

        // The SDK persists THIS value and replays it on every later turn, so a
        // diff leaking here would be paid for for the rest of the conversation.
        const seen = await modelOutput(raw);
        expect(seen).toContain("Successfully wrote");
        expect(seen).not.toContain("+");
        expect(seen.split("\n")).toHaveLength(1);
    });

    test("a huge rewrite is capped rather than dumping the file back", async () => {
        const before = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
        const after = Array.from({ length: 600 }, (_, i) => `changed ${i}`).join("\n");
        writeFileSync(join(dir, "big.txt"), before);
        await exec(read, { path: "big.txt" });
        const out = String(await exec(write, { path: "big.txt", content: after }));
        expect(out).toContain("more diff lines");
        expect(out.split("\n").length).toBeLessThan(260);
    });
});
