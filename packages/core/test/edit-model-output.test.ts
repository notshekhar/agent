import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool } from "../src/tools/edit";
import { createReadTool } from "../src/tools/read";

const dir = mkdtempSync(join(tmpdir(), "loop-edit-model-output-"));
const ctx = { cwd: dir };
const read = createReadTool(ctx);
const edit = createEditTool(ctx);
const opts = {} as never;

const exec = <T>(t: { execute?: unknown }, input: T) =>
    (t.execute as (i: T, o: unknown) => Promise<unknown>)(input, opts);

/** What the model is actually told, as the AI SDK would compute it. */
const modelOutput = (output: unknown): string => {
    const toModelOutput = (edit as { toModelOutput?: (o: { output: unknown }) => { value: string } }).toModelOutput;
    if (!toModelOutput) throw new Error("edit tool defines no toModelOutput");
    return toModelOutput({ output }).value;
};

/** A file the edit tool will accept: written, then read so the registry knows it. */
const seed = async (name: string, content: string): Promise<string> => {
    writeFileSync(join(dir, name), content);
    await exec(read, { path: name });
    return name;
};

describe("edit model output", () => {
    test("the UIs still get the whole diff", async () => {
        const path = await seed("ui.txt", "one\ntwo\nthree\n");
        const raw = String(await exec(edit, { path, edits: [{ oldText: "two", newText: "TWO" }] }));
        expect(raw).toContain("Successfully replaced 1 block(s)");
        expect(raw).toContain("+");
        expect(raw).toContain("TWO");
        expect(raw).toContain("-");
    });

    test("the diff never reaches the model", async () => {
        const path = await seed("hidden.txt", "keep\nbefore\nkeep\n");
        const raw = await exec(edit, { path, edits: [{ oldText: "before", newText: "after" }] });

        // The SDK persists THIS value and replays it on every later turn, so a
        // diff leaking here would be paid for for the rest of the conversation.
        const seen = modelOutput(raw);
        expect(seen).toBe("Successfully replaced 1 block(s) in hidden.txt.");
        expect(seen).not.toContain("\n+");
        expect(seen).not.toContain("after");
        expect(seen.length).toBeLessThan(String(raw).length);
    });

    test("a fuzzy match reaches the model whole — the file is not what it thinks", async () => {
        // The file holds an em dash; the model sends an ASCII hyphen. Exact
        // search fails, the fuzzy fold matches, and what got replaced is not
        // byte-for-byte what was asked for.
        const path = await seed("fuzzy.txt", "alpha \u2014 beta\ntail\n");
        const raw = await exec(edit, { path, edits: [{ oldText: "alpha - beta", newText: "omega" }] });

        const seen = modelOutput(raw);
        expect(seen).toBe(String(raw));
        expect(seen).toContain("edits[0] matched text that differs");
        expect(seen).toContain("omega");
    });

    test("an exact match alongside a fuzzy one still reports the fuzzy one", async () => {
        const path = await seed("mixed.txt", "first \u2014 one\nsecond\n");
        const raw = await exec(edit, {
            path,
            edits: [
                { oldText: "first - one", newText: "1st" },
                { oldText: "second", newText: "2nd" },
            ],
        });
        const seen = modelOutput(raw);
        expect(seen).toContain("edits[0] matched text that differs");
        expect(seen).not.toContain("edits[1]");
        expect(seen).toContain("1st");
    });
});
