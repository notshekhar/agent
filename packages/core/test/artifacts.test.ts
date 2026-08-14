import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ArtifactError,
    artifactFilePath,
    artifactsDir,
    createArtifact,
    deleteArtifact,
    getArtifact,
    isValidArtifactId,
    listArtifacts,
    readArtifact,
    setArtifactsDirForTests,
    updateArtifactMeta,
} from "../src/artifacts";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loop-artifacts-"));
    setArtifactsDirForTests(root);
});

afterEach(() => {
    setArtifactsDirForTests(null);
    rmSync(root, { recursive: true, force: true });
});

/** What the agent would do with the path it was handed. */
function writeContent(id: string, content: string): void {
    writeFileSync(artifactFilePath(getArtifact(id)!), content, "utf8");
}

/** Force a content file's mtime, so ordering assertions don't race the clock. */
function touch(id: string, whenMs: number): void {
    const secs = whenMs / 1000;
    utimesSync(artifactFilePath(getArtifact(id)!), secs, secs);
}

describe("create", () => {
    test("reserves an id and a path without creating the file", () => {
        const meta = createArtifact({
            title: "  Q3 Report  ",
            kind: "html",
            description: "  A report  ",
            favicon: "📊",
            sessionId: "sess-1",
        });

        expect(isValidArtifactId(meta.id)).toBe(true);
        expect(meta.title).toBe("Q3 Report"); // trimmed
        expect(meta.description).toBe("A report");
        expect(meta.sessionId).toBe("sess-1");
        expect(artifactFilePath(meta)).toBe(join(artifactsDir(), meta.id, "index.html"));

        // Nothing written yet. An empty file here would be indistinguishable
        // from one the agent deliberately wrote empty.
        expect(meta.written).toBe(false);
        expect(meta.size).toBe(0);
        expect(meta.updatedAt).toBe(meta.createdAt);
        expect(() => readArtifact(meta.id)).toThrow(/no content yet/);
    });

    test("the kind fixes the filename, so a path is derivable", () => {
        const html = createArtifact({ title: "H", kind: "html" });
        const md = createArtifact({ title: "M", kind: "markdown" });
        expect(html.file).toBe("index.html");
        expect(md.file).toBe("index.md");
    });

    test("each create is a distinct artifact", () => {
        const a = createArtifact({ title: "A", kind: "html" });
        const b = createArtifact({ title: "A", kind: "html" });
        expect(a.id).not.toBe(b.id);
        expect(listArtifacts()).toHaveLength(2);
    });

    test("refuses a blank title and an unknown kind", () => {
        expect(() => createArtifact({ title: "   ", kind: "html" })).toThrow(/needs a title/);
        expect(() => createArtifact({ title: "A", kind: "pdf" as never })).toThrow(/Unknown artifact kind/);
        expect(listArtifacts()).toHaveLength(0);
    });
});

describe("content is read from the file, never cached in meta", () => {
    test("writing the handed-out path fills the artifact in", () => {
        const { id } = createArtifact({ title: "A", kind: "html" });
        writeContent(id, "<h1>hi</h1>");

        const meta = getArtifact(id)!;
        expect(meta.written).toBe(true);
        expect(meta.size).toBe(11);
        expect(readArtifact(id)).toBe("<h1>hi</h1>");
    });

    test("an edit made directly to the file cannot leave the listing stale", () => {
        // The whole reason size/updatedAt are derived: the agent edits the file
        // in place with the ordinary edit tool, never telling this module.
        const { id } = createArtifact({ title: "A", kind: "html" });
        writeContent(id, "v1");
        const first = getArtifact(id)!;

        writeContent(id, "a much longer v2");
        const second = getArtifact(id)!;

        expect(second.size).toBeGreaterThan(first.size);
        expect(second.size).toBe(16);
        expect(readArtifact(id)).toBe("a much longer v2");
    });

    test("size is bytes, not UTF-16 code units", () => {
        const { id } = createArtifact({ title: "A", kind: "markdown" });
        writeContent(id, "é");
        expect(getArtifact(id)!.size).toBe(2);
    });

    test("deleting the content file reverts the artifact to unwritten", () => {
        const { id } = createArtifact({ title: "A", kind: "html" });
        writeContent(id, "x");
        rmSync(artifactFilePath(getArtifact(id)!));
        expect(getArtifact(id)!.written).toBe(false);
    });
});

describe("metadata updates", () => {
    test("retitling keeps the id, the path and the content", () => {
        const created = createArtifact({ title: "Draft", kind: "html" });
        writeContent(created.id, "<p>body</p>");

        const updated = updateArtifactMeta(created.id, { title: "Final", description: "done" });
        expect(updated.id).toBe(created.id);
        expect(updated.title).toBe("Final");
        expect(updated.description).toBe("done");
        expect(updated.createdAt).toBe(created.createdAt);
        expect(readArtifact(created.id)).toBe("<p>body</p>");
        expect(listArtifacts()).toHaveLength(1);
    });

    test("an empty description or favicon clears it", () => {
        const { id } = createArtifact({ title: "A", kind: "html", description: "d", favicon: "📊" });
        const updated = updateArtifactMeta(id, { description: "  ", favicon: "" });
        expect(updated.description).toBeUndefined();
        expect(updated.favicon).toBeUndefined();
    });

    test("refuses a blank title and an unknown id", () => {
        const { id } = createArtifact({ title: "A", kind: "html" });
        expect(() => updateArtifactMeta(id, { title: "   " })).toThrow(/needs a title/);
        expect(() => updateArtifactMeta("aaaaaaaaaaaa", { title: "X" })).toThrow(ArtifactError);
        expect(getArtifact(id)!.title).toBe("A");
    });
});

describe("listing and lookup", () => {
    test("most recently modified first, following in-place edits", () => {
        const a = createArtifact({ title: "A", kind: "html" });
        const b = createArtifact({ title: "B", kind: "html" });
        writeContent(a.id, "a");
        writeContent(b.id, "b");
        touch(a.id, 1_000_000);
        touch(b.id, 2_000_000);
        expect(listArtifacts().map((x) => x.id)).toEqual([b.id, a.id]);

        // Editing A's file must reorder the list even though no directory was
        // added or removed — the cache has to notice a content mtime.
        writeContent(a.id, "a2");
        touch(a.id, 3_000_000);
        expect(listArtifacts().map((x) => x.id)).toEqual([a.id, b.id]);
    });

    test("ignores junk in the artifacts dir", () => {
        createArtifact({ title: "A", kind: "html" });
        mkdirSync(join(root, "not-an-id"));
        mkdirSync(join(root, "bbbbbbbbbbbb")); // valid id shape, no meta.json
        writeFileSync(join(root, "stray.txt"), "x");
        expect(listArtifacts()).toHaveLength(1);
    });

    test("a meta.json naming another directory is treated as corrupt", () => {
        const { id } = createArtifact({ title: "A", kind: "html" });
        const record = { ...getArtifact(id)!, id: "cccccccccccc" };
        writeFileSync(join(root, id, "meta.json"), JSON.stringify(record), "utf8");
        expect(getArtifact(id)).toBeNull();
        expect(listArtifacts()).toHaveLength(0);
    });

    test("listing an absent dir is empty, not an error", () => {
        setArtifactsDirForTests(join(root, "nope"));
        expect(listArtifacts()).toEqual([]);
    });

    test("delete removes the directory and reports whether it existed", () => {
        const { id } = createArtifact({ title: "A", kind: "html" });
        writeContent(id, "x");
        expect(deleteArtifact(id)).toBe(true);
        expect(deleteArtifact(id)).toBe(false);
        expect(getArtifact(id)).toBeNull();
        expect(listArtifacts()).toHaveLength(0);
    });
});

describe("id validation", () => {
    // Ids become path segments and reach the store from the RPC layer — a
    // traversal here would read or delete outside the store.
    const hostile = ["../../etc", "..", ".", "", "a/b", "AAAAAAAAAAAA", "aaaaaaaaaaa", "aaaaaaaaaaaaa", "g".repeat(12)];

    test("rejects anything that is not exactly 12 lowercase hex chars", () => {
        for (const id of hostile) expect(isValidArtifactId(id)).toBe(false);
    });

    test("lookups and deletes with a hostile id are refused, not resolved", () => {
        for (const id of hostile) {
            expect(getArtifact(id)).toBeNull();
            expect(deleteArtifact(id)).toBe(false);
        }
        expect(() => readArtifact("../../etc/passwd")).toThrow(ArtifactError);
        expect(() => updateArtifactMeta("../../etc", { title: "X" })).toThrow(ArtifactError);
    });
});
