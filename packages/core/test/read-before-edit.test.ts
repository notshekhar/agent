import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "../src/tools/read";
import { createEditTool } from "../src/tools/edit";
import { createWriteTool } from "../src/tools/write";

const dir = mkdtempSync(join(tmpdir(), "loop-rbe-"));
const ctx = { cwd: dir };
const read = createReadTool(ctx);
const edit = createEditTool(ctx);
const write = createWriteTool(ctx);
const opts = {} as never;

const exec = <T>(t: { execute?: unknown }, input: T) =>
    (t.execute as (i: T, o: unknown) => Promise<unknown>)(input, opts);

describe("read-before-modify enforcement", () => {
    test("write creates new files freely", async () => {
        await exec(write, { path: "a.txt", content: "hello" });
        expect(String(await exec(read, { path: "a.txt" }))).toContain("hello");
    });

    test("edit without read is rejected", async () => {
        writeFileSync(join(dir, "unread.txt"), "secret");
        await expect(exec(edit, { path: "unread.txt", edits: [{ oldText: "secret", newText: "x" }] })).rejects.toThrow(
            /has not been read/,
        );
    });

    test("edit after read succeeds, and immediate re-edit too", async () => {
        writeFileSync(join(dir, "b.txt"), "one two");
        await exec(read, { path: "b.txt" });
        await exec(edit, { path: "b.txt", edits: [{ oldText: "one", newText: "1" }] });
        // our own edit refreshed the registry — second edit allowed
        await exec(edit, { path: "b.txt", edits: [{ oldText: "two", newText: "2" }] });
    });

    test("external change after read forces a re-read", async () => {
        const p = join(dir, "c.txt");
        writeFileSync(p, "alpha");
        await exec(read, { path: "c.txt" });
        writeFileSync(p, "alpha beta");
        utimesSync(p, new Date(), new Date(Date.now() + 5000)); // guarantee newer mtime
        await expect(exec(edit, { path: "c.txt", edits: [{ oldText: "alpha", newText: "A" }] })).rejects.toThrow(
            /changed on disk/,
        );
        await exec(read, { path: "c.txt" });
        await exec(edit, { path: "c.txt", edits: [{ oldText: "beta", newText: "B" }] });
    });

    test("write over an existing unread file is rejected; new files pass freely", async () => {
        writeFileSync(join(dir, "d.txt"), "precious");
        await expect(exec(write, { path: "d.txt", content: "clobber" })).rejects.toThrow(/has not been read/);
        await exec(read, { path: "d.txt" });
        await exec(write, { path: "d.txt", content: "ok now" });
        // and a write unlocks subsequent edits of the agent's own content
        await exec(edit, { path: "d.txt", edits: [{ oldText: "ok now", newText: "edited" }] });
        // brand-new path needs no read
        await exec(write, { path: "brand-new.txt", content: "fresh" });
    });

    test("clearReadRegistry resets the session slate", async () => {
        const { clearReadRegistry } = await import("../src/tools/utils/read-registry");
        writeFileSync(join(dir, "e.txt"), "data");
        await exec(read, { path: "e.txt" });
        clearReadRegistry();
        await expect(exec(edit, { path: "e.txt", edits: [{ oldText: "data", newText: "x" }] })).rejects.toThrow(
            /has not been read/,
        );
    });

    test("sessions don't share read state (RPC multi-session)", async () => {
        const readA = createReadTool({ cwd: dir, sessionId: "A" });
        const editA = createEditTool({ cwd: dir, sessionId: "A" });
        const editB = createEditTool({ cwd: dir, sessionId: "B" });
        writeFileSync(join(dir, "f.txt"), "shared");
        await exec(readA, { path: "f.txt" });
        // B never read the file — A's read must not unlock it for B.
        await expect(exec(editB, { path: "f.txt", edits: [{ oldText: "shared", newText: "x" }] })).rejects.toThrow(
            /has not been read/,
        );
        await exec(editA, { path: "f.txt", edits: [{ oldText: "shared", newText: "mine" }] });
    });

    test("clearing one session leaves another's reads intact", async () => {
        const { clearReadRegistry } = await import("../src/tools/utils/read-registry");
        const readA = createReadTool({ cwd: dir, sessionId: "A2" });
        const editA = createEditTool({ cwd: dir, sessionId: "A2" });
        const readB = createReadTool({ cwd: dir, sessionId: "B2" });
        const editB = createEditTool({ cwd: dir, sessionId: "B2" });
        writeFileSync(join(dir, "g.txt"), "keep both");
        await exec(readA, { path: "g.txt" });
        await exec(readB, { path: "g.txt" });
        clearReadRegistry("A2");
        await expect(exec(editA, { path: "g.txt", edits: [{ oldText: "keep", newText: "x" }] })).rejects.toThrow(
            /has not been read/,
        );
        await exec(editB, { path: "g.txt", edits: [{ oldText: "both", newText: "B-still-ok" }] });
    });
});
