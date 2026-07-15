import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractImagesFromInput, filterAttachmentsByModalities } from "../src/agent/images";

// 1x1 transparent PNG
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

const root = join(tmpdir(), `loop-images-test-${process.pid}`);
const spaceyDir = join(root, "with space (x)");
// The canonical offender: macOS screenshot naming.
const spacey = join(spaceyDir, "Screenshot 2026-07-15 at 1.23.45 PM.png");
const plain = join(root, "plain.png");

beforeAll(() => {
    mkdirSync(spaceyDir, { recursive: true });
    writeFileSync(plain, PNG);
    writeFileSync(spacey, PNG);
});
afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const shellEscape = (p: string) => p.replace(/[ ()]/g, (c) => "\\" + c);

describe("extractImagesFromInput drop shapes", () => {
    test("plain absolute path", () => {
        const r = extractImagesFromInput(plain, root);
        expect(r.images.length).toBe(1);
        expect(r.textWithoutPaths).toBe("");
    });

    test("shell-escaped spaces and parens (iTerm/Terminal drop)", () => {
        const r = extractImagesFromInput(shellEscape(spacey), root);
        expect(r.images.length).toBe(1);
        expect(r.images[0]!.path).toBe(spacey);
    });

    test("UNESCAPED spaces when the whole input is the path (Finder paste)", () => {
        const r = extractImagesFromInput(spacey, root);
        expect(r.images.length).toBe(1);
        expect(r.images[0]!.path).toBe(spacey);
        expect(r.textWithoutPaths).toBe("");
    });

    test("unescaped path with trailing newline (drop artifacts)", () => {
        const r = extractImagesFromInput(spacey + "\n", root);
        expect(r.images.length).toBe(1);
    });

    test("quoted paths", () => {
        expect(extractImagesFromInput(`'${spacey}'`, root).images.length).toBe(1);
        expect(extractImagesFromInput(`"${spacey}"`, root).images.length).toBe(1);
    });

    test("file:// URL with percent-encoding", () => {
        const r = extractImagesFromInput("file://" + encodeURI(spacey), root);
        expect(r.images.length).toBe(1);
        expect(r.images[0]!.path).toBe(spacey);
    });

    test("file:// URL inside prose is extracted, prose kept", () => {
        const r = extractImagesFromInput("look at file://" + encodeURI(spacey) + " please", root);
        expect(r.images.length).toBe(1);
        expect(r.textWithoutPaths).toBe("look at please");
    });

    test("prose mentioning a nonexistent image path stays plain text", () => {
        const r = extractImagesFromInput("see docs/missing.png for detail", root);
        expect(r.images.length).toBe(0);
        expect(r.textWithoutPaths).toBe("see docs/missing.png for detail");
    });

    test("whole-input fallback does not fire for prose ending in a real path", () => {
        // Not path-like at the start — token regex still catches the escaped form.
        const r = extractImagesFromInput("look at " + shellEscape(spacey) + " now", root);
        expect(r.images.length).toBe(1);
        expect(r.textWithoutPaths).toBe("look at now");
    });

    test("two files in one drop", () => {
        const r = extractImagesFromInput(plain + " " + shellEscape(spacey), root);
        expect(r.images.length).toBe(2);
    });

    test("[image:] sentinel keeps its token in the text", () => {
        const r = extractImagesFromInput(`[image:${spacey}]`, root);
        expect(r.images.length).toBe(1);
        expect(r.textWithoutPaths).toContain("[image:");
    });

    test("PDF paths extract with application/pdf media type", () => {
        const pdf = join(root, "doc.pdf");
        writeFileSync(pdf, Buffer.from("%PDF-1.4 fake"));
        const r = extractImagesFromInput(pdf, root);
        expect(r.images.length).toBe(1);
        expect(r.images[0]!.mediaType).toBe("application/pdf");
    });
});

describe("filterAttachmentsByModalities", () => {
    const img = { data: Buffer.alloc(0), mediaType: "image/png", path: "/a.png" };
    const pdf = { data: Buffer.alloc(0), mediaType: "application/pdf", path: "/a.pdf" };

    test("images pass when modalities include image; unknown modalities allow", () => {
        expect(filterAttachmentsByModalities([img], ["text", "image"], "xai").allowed.length).toBe(1);
        expect(filterAttachmentsByModalities([img], undefined, "xai").allowed.length).toBe(1);
        expect(filterAttachmentsByModalities([img], ["text"], "xai").allowed.length).toBe(0);
    });

    test("PDF needs modality AND an inline-capable provider — the grok repro", () => {
        // xAI lists pdf in the catalog but its API rejects inline PDF bytes.
        const grok = filterAttachmentsByModalities([pdf], ["text", "image", "pdf"], "xai");
        expect(grok.allowed.length).toBe(0);
        expect(grok.rejected.length).toBe(1);
        const claude = filterAttachmentsByModalities([pdf], ["text", "image", "pdf"], "anthropic");
        expect(claude.allowed.length).toBe(1);
        // Unknown provider / missing provider: reject — a wrong yes kills the turn.
        expect(filterAttachmentsByModalities([pdf], ["pdf"], "somecustom").allowed.length).toBe(0);
        expect(filterAttachmentsByModalities([pdf], ["pdf"]).allowed.length).toBe(0);
    });

    test("mixed drop splits per file", () => {
        const r = filterAttachmentsByModalities([img, pdf], ["text", "image", "pdf"], "xai");
        expect(r.allowed.map((i) => i.path)).toEqual(["/a.png"]);
        expect(r.rejected.map((i) => i.path)).toEqual(["/a.pdf"]);
    });
});
