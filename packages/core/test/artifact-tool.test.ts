import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactFilePath, getArtifact, listArtifacts, readArtifact, setArtifactsDirForTests } from "../src/artifacts";
import { createArtifactTool } from "../src/tools/artifact";
import { setPlanMode } from "../src/tools/utils/plan-mode";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loop-artifacts-"));
    setArtifactsDirForTests(root);
});

afterEach(() => {
    setArtifactsDirForTests(null);
    setPlanMode(undefined, false);
    rmSync(root, { recursive: true, force: true });
});

interface Input {
    title: string;
    kind?: "html" | "markdown";
    description?: string;
    favicon?: string;
    id?: string;
}

const run = async (input: Input, opts: { sessionId?: string; signal?: AbortSignal } = {}): Promise<string> => {
    const tool = createArtifactTool({ sessionId: opts.sessionId });
    return (await tool.execute!(input, {
        toolCallId: "t1",
        messages: [],
        abortSignal: opts.signal,
    } as never)) as string;
};

/** The path the tool told the agent to write to. */
const pathFrom = (out: string): string => out.split("\n")[1].replace("Write the content to: ", "");

describe("artifact tool", () => {
    test("creates an artifact and hands back a real path to write", async () => {
        const out = await run({ title: "Q3 Report", favicon: "📊" });

        const [meta] = listArtifacts();
        expect(meta.title).toBe("Q3 Report");
        expect(meta.favicon).toBe("📊");
        expect(out).toContain("Created");
        expect(out).toContain(meta.id);

        // The path is the artifact's own content file — an ordinary absolute
        // path the write tool can take with no special casing.
        expect(pathFrom(out)).toBe(artifactFilePath(meta));
        expect(pathFrom(out)).toBe(join(root, meta.id, "index.html"));

        // And the URL it quotes resolves to that same file.
        const url = out.split("\n")[2].replace("It will open at: ", "");
        expect(fileURLToPath(url)).toBe(artifactFilePath(meta));
    });

    test("the whole flow: create, write the path, edit it in place", async () => {
        const out = await run({ title: "Report" });
        const path = pathFrom(out);
        const { id } = listArtifacts()[0];

        // Nothing exists until the agent writes — no empty file to mistake for
        // deliberate content.
        expect(getArtifact(id)!.written).toBe(false);

        writeFileSync(path, "<h1>v1</h1>", "utf8"); // what `write` would do
        expect(getArtifact(id)!.written).toBe(true);
        expect(readArtifact(id)).toBe("<h1>v1</h1>");

        writeFileSync(path, "<h1>v2</h1>", "utf8"); // what `edit` would do
        expect(readArtifact(id)).toBe("<h1>v2</h1>");
        // Revising does not mint a second artifact, and the path never moved.
        expect(listArtifacts()).toHaveLength(1);
        expect(artifactFilePath(getArtifact(id)!)).toBe(path);
    });

    test("defaults to html, and markdown is opt-in", async () => {
        await run({ title: "A" });
        expect(listArtifacts()[0].kind).toBe("html");
        expect(listArtifacts()[0].file).toBe("index.html");

        const out = await run({ title: "B", kind: "markdown" });
        expect(pathFrom(out).endsWith("index.md")).toBe(true);
    });

    test("an id retitles instead of creating", async () => {
        await run({ title: "Draft" });
        const { id } = listArtifacts()[0];
        writeFileSync(artifactFilePath(getArtifact(id)!), "body", "utf8");

        const out = await run({ title: "Final", id });
        expect(out).toContain("Updated");
        expect(listArtifacts()).toHaveLength(1);
        expect(listArtifacts()[0].title).toBe("Final");
        expect(readArtifact(id)).toBe("body"); // content untouched
    });

    test("an unknown id is an error, not a silent create", async () => {
        await expect(run({ title: "X", id: "aaaaaaaaaaaa" })).rejects.toThrow(/No such artifact/);
        expect(listArtifacts()).toHaveLength(0);
    });

    test("records the session so a page can be traced back to its chat", async () => {
        await run({ title: "A" }, { sessionId: "sess-9" });
        expect(listArtifacts()[0].sessionId).toBe("sess-9");
    });

    test("plan mode refuses to create, like every other mutation", async () => {
        setPlanMode("sess-plan", true);
        await expect(run({ title: "A" }, { sessionId: "sess-plan" })).rejects.toThrow();
        expect(listArtifacts()).toHaveLength(0);
    });

    test("an already-aborted signal stops before anything is created", async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(run({ title: "A" }, { signal: ac.signal })).rejects.toThrow("Operation aborted");
        expect(listArtifacts()).toHaveLength(0);
    });

    test("a blank title is refused before a directory appears", async () => {
        await expect(run({ title: "   " })).rejects.toThrow(/needs a title/);
        expect(listArtifacts()).toHaveLength(0);
    });
});
