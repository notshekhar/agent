import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactFilePath, getArtifact, listArtifacts, readArtifact, setArtifactsDirForTests } from "../src/artifacts";
import { artifactResultSummary, createArtifactTool, parseArtifactResult } from "../src/tools/artifact";
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

        // The openable URL moved into the card payload — the model is no
        // longer told it, so it can no longer paste it into a reply.
        const url = parseArtifactResult(out)!.url;
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

/**
 * The result is two halves: a summary for the model, and a card payload for the
 * UIs. The separator between them is a contract with two ported parsers (the
 * desktop's artifacts.ts and the terminal's tool-execution.ts), so it is worth
 * pinning rather than assuming.
 */
describe("the model and the UI get different halves", () => {
    test("the model never sees a file:// URL", async () => {
        // Handing it one is why replies used to contain a raw
        // file:///Users/…/index.html that nothing could click.
        const out = await run({ title: "Q3 Report" });
        const summary = artifactResultSummary(out);
        // `file:///` is a URL; the summary only mentions "file://" when telling
        // the model NOT to print one.
        expect(summary).not.toContain("file:///");
        expect(out).toContain("file:///"); // …but the payload still carries it
    });

    test("the summary still tells the model where to write", async () => {
        const out = await run({ title: "Q3 Report" });
        const { id } = listArtifacts()[0];
        const summary = artifactResultSummary(out);
        expect(summary).toContain(artifactFilePath(getArtifact(id)!));
        expect(summary).toContain(id);
    });

    test("the payload carries what a card needs", async () => {
        const out = await run({ title: "Q3 Report", kind: "markdown", favicon: "📊" });
        const payload = parseArtifactResult(out)!;
        const meta = getArtifact(payload.id)!;
        expect(payload.title).toBe("Q3 Report");
        expect(payload.kind).toBe("markdown");
        expect(payload.favicon).toBe("📊");
        expect(payload.path).toBe(artifactFilePath(meta));
        expect(fileURLToPath(payload.url)).toBe(artifactFilePath(meta));
    });

    test("an update carries a payload too, so the card still renders", async () => {
        await run({ title: "Draft" });
        const { id } = listArtifacts()[0];
        const out = await run({ title: "Final", id });
        expect(parseArtifactResult(out)?.id).toBe(id);
        expect(parseArtifactResult(out)?.title).toBe("Final");
    });

    test("parsing tolerates anything that is not an artifact result", () => {
        // Every tool's output flows through the same renderer, so this runs
        // against bash output, truncated results, and non-strings.
        for (const junk of ["", "Successfully wrote 12 bytes", "{}", null, undefined, 42]) {
            expect(parseArtifactResult(junk)).toBeNull();
        }
        // A payload cut off in transit must not throw inside a render.
        expect(parseArtifactResult('Created artifact "X".\n artifact:{"id":"a1b2')).toBeNull();
        // And a summary with no payload comes back unchanged.
        expect(artifactResultSummary("plain output")).toBe("plain output");
    });
});

/**
 * The card has to survive a reload.
 *
 * `toModelOutput` keeps the JSON payload out of the model's context, and the AI
 * SDK persists the model-facing value — so a reopened thread has only the
 * summary. Without a fallback the card appeared while the turn ran and was gone
 * the next time the thread was opened, which is worse than never showing one.
 */
describe("the card survives replay", () => {
    /** What a reloaded thread actually has: the model-facing half, alone. */
    const persisted = (out: string) => artifactResultSummary(out);

    test("rebuilds id and title from the persisted summary", async () => {
        const out = await run({ title: "Q3 Report" });
        const { id } = listArtifacts()[0];

        const replayed = parseArtifactResult(persisted(out));
        expect(replayed).not.toBeNull();
        expect(replayed!.id).toBe(id);
        expect(replayed!.title).toBe("Q3 Report");
    });

    test("an updated artifact replays too", async () => {
        await run({ title: "Draft" });
        const { id } = listArtifacts()[0];
        const out = await run({ title: "Final", id });
        const replayed = parseArtifactResult(persisted(out))!;
        expect(replayed.id).toBe(id);
        expect(replayed.title).toBe("Final");
    });

    test("a title with punctuation still round-trips", async () => {
        const out = await run({ title: "Q3: revenue (and churn)" });
        expect(parseArtifactResult(persisted(out))!.title).toBe("Q3: revenue (and churn)");
    });

    test("the live payload still wins when it is there", async () => {
        // Full fidelity during the turn; the fallback is only for replay.
        const out = await run({ title: "Q3 Report", kind: "markdown" });
        expect(parseArtifactResult(out)!.kind).toBe("markdown");
        expect(parseArtifactResult(persisted(out))!.kind).toBeUndefined();
    });

    test("another tool's output is still not an artifact", async () => {
        // The fallback scans text, so it must not match ordinary prose.
        expect(parseArtifactResult("Successfully wrote 812 bytes to artifact.ts")).toBeNull();
        expect(parseArtifactResult('the artifact "X" was fine')).toBeNull();
    });
});
