import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ARTIFACT_KIND_EXECUTES,
    ARTIFACT_KINDS,
    ArtifactError,
    artifactFilePath,
    type ArtifactKind,
    artifactsDir,
    createArtifact,
    deleteArtifact,
    exportArtifact,
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

    test("every kind has a filename, and the extension matches the kind", () => {
        // A kind added without a FILE_FOR_KIND entry would create an artifact
        // whose path is `undefined`, so this walks the exported list rather
        // than naming them.
        const expected: Record<ArtifactKind, string> = {
            html: ".html",
            markdown: ".md",
            svg: ".svg",
            json: ".json",
            csv: ".csv",
            text: ".txt",
        };
        for (const kind of ARTIFACT_KINDS) {
            const meta = createArtifact({ title: kind, kind });
            expect(meta.file).toBe(`index${expected[kind]}`);
            expect(artifactFilePath(meta).endsWith(meta.file)).toBe(true);
        }
        expect(listArtifacts()).toHaveLength(ARTIFACT_KINDS.length);
    });

    test("only html and svg are treated as able to execute", () => {
        // This is what decides whether a viewer may render an artifact inline
        // or must sandbox it. svg belongs with html: an SVG document can carry
        // <script>, which is the mistake this table exists to prevent.
        expect(ARTIFACT_KIND_EXECUTES).toEqual({
            html: true,
            svg: true,
            markdown: false,
            json: false,
            csv: false,
            text: false,
        });
        // And every kind has a verdict — a missing entry reads as falsy, which
        // would silently route an executable kind into the inline renderer.
        for (const kind of ARTIFACT_KINDS) {
            expect(typeof ARTIFACT_KIND_EXECUTES[kind]).toBe("boolean");
        }
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

describe("export", () => {
    let dest: string;
    beforeEach(() => {
        dest = mkdtempSync(join(tmpdir(), "loop-export-"));
    });
    afterEach(() => rmSync(dest, { recursive: true, force: true }));

    test("copies the content out under a name derived from the title", () => {
        // On disk every artifact is `index.<ext>` so a path follows from a kind;
        // in a Downloads folder that would land four files all called
        // index.html, so exporting is where the title becomes the name.
        const { id } = createArtifact({ title: "Q3 Revenue Report!", kind: "html" });
        writeContent(id, "<h1>hi</h1>");

        const out = exportArtifact(id, dest);
        expect(out).toBe(join(dest, "q3-revenue-report.html"));
        expect(readFileSync(out, "utf8")).toBe("<h1>hi</h1>");
    });

    test("the extension follows the kind", () => {
        const md = createArtifact({ title: "Notes", kind: "markdown" });
        writeContent(md.id, "# notes");
        expect(exportArtifact(md.id, dest).endsWith("notes.md")).toBe(true);

        const csv = createArtifact({ title: "Rows", kind: "csv" });
        writeContent(csv.id, "a,b");
        expect(exportArtifact(csv.id, dest).endsWith("rows.csv")).toBe(true);
    });

    test("never overwrites — a second export gets its own name", () => {
        // The destination is the user's folder. A download that destroys a file
        // that was already there is worse than a cluttered folder.
        const { id } = createArtifact({ title: "Report", kind: "html" });
        writeContent(id, "v1");
        const first = exportArtifact(id, dest);
        const second = exportArtifact(id, dest);
        const third = exportArtifact(id, dest);

        expect(first).toBe(join(dest, "report.html"));
        expect(second).toBe(join(dest, "report-2.html"));
        expect(third).toBe(join(dest, "report-3.html"));
        expect(readFileSync(first, "utf8")).toBe("v1");
    });

    test("a title that slugs to nothing falls back to the id", () => {
        // Punctuation-only or non-Latin titles leave an empty slug; the id is
        // never empty and is still the artifact's real name.
        const { id } = createArtifact({ title: "!!!", kind: "text" });
        writeContent(id, "x");
        expect(exportArtifact(id, dest)).toBe(join(dest, `${id}.txt`));
    });

    test("creates the destination folder if it is missing", () => {
        const { id } = createArtifact({ title: "Report", kind: "html" });
        writeContent(id, "x");
        const nested = join(dest, "a", "b");
        expect(exportArtifact(id, nested)).toBe(join(nested, "report.html"));
    });

    test("refuses an unknown id and an artifact with no content", () => {
        expect(() => exportArtifact("aaaaaaaaaaaa", dest)).toThrow(ArtifactError);
        const { id } = createArtifact({ title: "Empty", kind: "html" });
        expect(() => exportArtifact(id, dest)).toThrow(/no content yet/);
    });
});
