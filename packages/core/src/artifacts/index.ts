/**
 * Artifacts — standalone pages the agent produces (reports, docs, dashboards)
 * that live outside any repo, under ~/.loop/artifacts.
 *
 * **The directory is the registry.** Each artifact is a folder holding its
 * content file plus a `meta.json`, and `list()` is a scan. The obvious
 * alternative was a table in the session DB (sessions/db.ts), which would list
 * faster and join to sessions — but it also introduces the classic divergence
 * bug: a user deletes a folder and the DB still advertises it, or the DB is
 * lost and every artifact on disk becomes unreachable. With the metadata beside
 * the content there is exactly one source of truth, an artifact survives being
 * copied to another machine, and there is no schema migration to own. The scan
 * is one readdir plus N small reads; artifacts number in the tens, not the
 * millions, and the result is memoized per directory mtime.
 *
 * **Create first, then write.** This module hands out an artifact's PATH; it
 * never takes its content. The agent creates an artifact, gets back an ordinary
 * absolute path, and writes and edits that path with the ordinary write/edit
 * tools — so permission rules, hooks, the read-before-modify registry and the
 * diff UI all keep working with no special cases, and revising an artifact is
 * just an edit rather than a re-publish.
 *
 * The rejected alternative was publish-after-write: the agent writes
 * `report.html` into the working directory and hands that path over to be
 * copied in. It leaves a stray file in the user's repo, needs path-matching to
 * work out that a second publish means "update", and — worst — makes the stored
 * copy and the metadata drift the moment anyone touches either one.
 *
 * **The file is the content truth.** `meta.json` holds only what the filesystem
 * cannot say: title, description, favicon, which session made it. Size and
 * last-modified are read from the file itself, so an `edit` the agent makes
 * directly cannot leave the listing stale.
 */
import { randomBytes } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getConfigDir } from "../brand";

/**
 * What an artifact can be.
 *
 * Everything a language model can author is text, which is what bounds this
 * list — there is no `pdf` or `png` here because the agent cannot write one.
 * PDF is an export format, not an authored kind.
 *
 * The split that matters is not the file extension but whether the content can
 * EXECUTE, because that decides where a viewer may render it. `html` and `svg`
 * can carry script and must be shown in something sandboxed; the rest are inert
 * data and can be rendered by the app itself. See ARTIFACT_KIND_EXECUTES.
 */
export type ArtifactKind = "html" | "markdown" | "svg" | "json" | "csv" | "text";

/**
 * Whether a kind's content can run code.
 *
 * `svg` is the one people get wrong: an SVG document can contain `<script>` and
 * event handlers, so it is every bit as executable as HTML and must never be
 * rendered inline by a trusting viewer. Everything else here is data that only
 * becomes dangerous if a renderer chooses to interpret it as markup.
 */
export const ARTIFACT_KIND_EXECUTES: Record<ArtifactKind, boolean> = {
    html: true,
    svg: true,
    markdown: false,
    json: false,
    csv: false,
    text: false,
};

/** The fields that live in `meta.json` — everything the filesystem can't say. */
export interface ArtifactRecord {
    /** Directory name under artifacts/, and the id everything else refers to. */
    id: string;
    title: string;
    description?: string;
    /** One or two emoji, shown as the page's tab icon and on its list row. */
    favicon?: string;
    kind: ArtifactKind;
    /** Content file name inside the artifact directory (never a path). */
    file: string;
    createdAt: number;
    /** Session that created it, when known — lets a UI link back to the chat. */
    sessionId?: string;
}

/** A record plus the facts read off the content file itself. */
export interface ArtifactMeta extends ArtifactRecord {
    /** Content file's mtime, or createdAt while nothing has been written yet. */
    updatedAt: number;
    /** Byte length on disk; 0 before the first write. */
    size: number;
    /** False until the agent has written the file it was given. */
    written: boolean;
}

/**
 * A page is a page: past this, something has gone wrong rather than been
 * authored, and no browser will open it usefully anyway. Enforced by the write
 * path (tools/artifact.ts) rather than here — this module never sees content.
 */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

const META_FILE = "meta.json";

/** The content file's name, per kind. Fixed, so a path is derivable from a kind. */
const FILE_FOR_KIND: Record<ArtifactKind, string> = {
    html: "index.html",
    markdown: "index.md",
    svg: "index.svg",
    json: "index.json",
    csv: "index.csv",
    text: "index.txt",
};

/** Every kind, for a tool's enum and a UI's filter. */
export const ARTIFACT_KINDS = Object.keys(FILE_FOR_KIND) as ArtifactKind[];

export class ArtifactError extends Error {}

/** Test override — the real dir is under the user's home, which tests must not touch. */
let artifactsDirOverride: string | null = null;

/** @internal Point the store at a temp dir; pass null to restore ~/.loop/artifacts. */
export function setArtifactsDirForTests(dir: string | null): void {
    artifactsDirOverride = dir;
    cache = null;
}

/** ~/.loop/artifacts — created on first write, not on read. */
export function artifactsDir(): string {
    return artifactsDirOverride ?? join(getConfigDir(), "artifacts");
}

/**
 * Ids are directory names, and they arrive from callers that did not mint them
 * — the RPC layer, and whatever a UI passes to open or delete. Anything not
 * matching this is rejected before it can be joined onto a path, so `../../..`
 * never becomes a lookup or a recursive delete.
 */
const ID_RE = /^[a-f0-9]{12}$/;

export function isValidArtifactId(id: string): boolean {
    return ID_RE.test(id);
}

function newId(): string {
    return randomBytes(6).toString("hex");
}

/** Absolute directory for an id, or throw rather than build a traversable path. */
function artifactDir(id: string): string {
    if (!isValidArtifactId(id)) throw new ArtifactError(`Invalid artifact id: ${id}`);
    return join(artifactsDir(), id);
}

/**
 * Absolute path of an artifact's content file — what the agent is told to write
 * to, and what a UI opens.
 */
export function artifactFilePath(meta: ArtifactRecord): string {
    return join(artifactDir(meta.id), meta.file);
}

/** Read the content file's stat, folding "not written yet" into the result. */
function statContent(record: ArtifactRecord): { updatedAt: number; size: number; written: boolean } {
    try {
        const s = statSync(artifactFilePath(record));
        return { updatedAt: s.mtimeMs, size: s.size, written: true };
    } catch {
        return { updatedAt: record.createdAt, size: 0, written: false };
    }
}

function hydrate(record: ArtifactRecord): ArtifactMeta {
    return { ...record, ...statContent(record) };
}

function readRecord(dir: string): ArtifactRecord | null {
    try {
        const raw = readFileSync(join(dir, META_FILE), "utf8");
        const record = JSON.parse(raw) as ArtifactRecord;
        // A directory whose meta doesn't describe itself is corrupt, not usable:
        // trusting `record.id` over the folder name would let a hand-edited file
        // point the store at another artifact's directory.
        if (!record || record.id !== basename(dir) || !record.file) return null;
        return record;
    } catch {
        return null;
    }
}

function writeRecord(record: ArtifactRecord): void {
    const dir = artifactDir(record.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, META_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * Memoized listing.
 *
 * Keyed on the artifacts dir's own mtime, which the filesystem bumps whenever a
 * child directory is added or removed — but NOT when an artifact's content file
 * changes, which is the common case now that the agent edits artifacts in
 * place. So the cache also holds each member's mtime and re-scans when one
 * moves. Cheap: the alternative is re-reading every meta.json on every render.
 */
let cache: { key: string; stamps: string; items: ArtifactMeta[] } | null = null;

function dirStamp(root: string): string {
    try {
        return `${root}:${statSync(root).mtimeMs}`;
    } catch {
        return `${root}:missing`;
    }
}

/** Every artifact, most recently modified first. */
export function listArtifacts(): ArtifactMeta[] {
    const root = artifactsDir();
    const key = dirStamp(root);
    let entries: string[];
    try {
        entries = readdirSync(root);
    } catch {
        return []; // Nothing created yet — the dir appears with the first artifact.
    }
    const records: ArtifactRecord[] = [];
    for (const name of entries) {
        if (!isValidArtifactId(name)) continue;
        const record = readRecord(join(root, name));
        if (record) records.push(record);
    }
    const items = records.map(hydrate);
    // Content mtimes are part of the key: an in-place edit changes an
    // artifact's updatedAt (and therefore the order) without touching the
    // parent directory.
    const stamps = items.map((a) => `${a.id}:${a.updatedAt}:${a.size}`).join("|");
    if (cache && cache.key === key && cache.stamps === stamps) return cache.items;
    // Most recent first; ties (same millisecond, or two never-written
    // artifacts sharing a createdAt) break on id so the order is stable
    // rather than left to readdir.
    items.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    cache = { key, stamps, items };
    return items;
}

export function getArtifact(id: string): ArtifactMeta | null {
    if (!isValidArtifactId(id)) return null;
    const record = readRecord(join(artifactsDir(), id));
    return record ? hydrate(record) : null;
}

/** The content written so far. Throws if the artifact or its file is absent. */
export function readArtifact(id: string): string {
    const meta = getArtifact(id);
    if (!meta) throw new ArtifactError(`No such artifact: ${id}`);
    if (!meta.written) throw new ArtifactError(`Artifact ${id} has no content yet`);
    return readFileSync(artifactFilePath(meta), "utf8");
}

export function deleteArtifact(id: string): boolean {
    if (!isValidArtifactId(id)) return false;
    const dir = join(artifactsDir(), id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    cache = null;
    return true;
}

export interface CreateArtifactInput {
    title: string;
    kind: ArtifactKind;
    description?: string;
    favicon?: string;
    sessionId?: string;
}

/**
 * Reserve an artifact and hand back where to write it.
 *
 * Deliberately does NOT create the content file. An empty file would be
 * indistinguishable from one the agent wrote as empty, and `write`'s
 * read-before-overwrite guard would then demand a read of a file that has never
 * had anything in it. The directory and its meta.json are enough to reserve the
 * id; `written` stays false until the agent writes the path it was given.
 */
export function createArtifact(input: CreateArtifactInput): ArtifactMeta {
    const title = input.title.trim();
    if (!title) throw new ArtifactError("An artifact needs a title");
    const file = FILE_FOR_KIND[input.kind];
    if (!file) throw new ArtifactError(`Unknown artifact kind: ${input.kind}`);

    const record: ArtifactRecord = {
        id: newId(),
        title,
        description: input.description?.trim() || undefined,
        favicon: input.favicon?.trim() || undefined,
        kind: input.kind,
        file,
        createdAt: Date.now(),
        sessionId: input.sessionId,
    };
    writeRecord(record);
    cache = null;
    return hydrate(record);
}

/**
 * Change an artifact's metadata — a retitle, a better description. The content
 * is not touched: that is what edit/write are for.
 */
export function updateArtifactMeta(
    id: string,
    patch: Partial<Pick<ArtifactRecord, "title" | "description" | "favicon">>,
): ArtifactMeta {
    const existing = getArtifact(id);
    if (!existing) throw new ArtifactError(`No such artifact: ${id}`);
    const title = patch.title?.trim();
    if (patch.title !== undefined && !title) throw new ArtifactError("An artifact needs a title");
    const { updatedAt: _u, size: _s, written: _w, ...record } = existing;
    const next: ArtifactRecord = {
        ...record,
        ...(title ? { title } : {}),
        ...(patch.description !== undefined ? { description: patch.description.trim() || undefined } : {}),
        ...(patch.favicon !== undefined ? { favicon: patch.favicon.trim() || undefined } : {}),
    };
    writeRecord(next);
    cache = null;
    return hydrate(next);
}

/**
 * A filename a human would recognise, derived from the title.
 *
 * The store names every content file `index.<ext>` so a path is derivable from
 * a kind alone — which is right on disk and useless in a Downloads folder,
 * where four artifacts would all arrive as `index.html`. Exporting is the one
 * place the title becomes the name.
 */
export function artifactFileName(meta: ArtifactRecord): string {
    const ext = FILE_FOR_KIND[meta.kind] ? FILE_FOR_KIND[meta.kind].replace(/^index/, "") : "";
    const slug = meta.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    // A title of only punctuation or non-Latin script slugs to nothing; the id
    // is never empty and is still the artifact's real name.
    return `${slug || meta.id}${ext}`;
}

/** Where an export lands when the caller does not say. */
export function defaultExportDir(): string {
    return join(homedir(), "Downloads");
}

/**
 * Copy an artifact out to a real folder, and say where it landed.
 *
 * This is what "download" means for a local-first tool: the artifact is already
 * a single self-contained file, so sharing it is a copy — no bundle, no server.
 * Both clients call this rather than each rolling their own, so the terminal
 * and the app produce byte-identical results with the same name.
 *
 * Never overwrites. A second export of the same artifact makes `report-2.html`
 * rather than silently replacing whatever was already there — the folder is the
 * user's, and a download that destroys a file is worse than a cluttered one.
 */
export function exportArtifact(id: string, destDir?: string): string {
    const meta = getArtifact(id);
    if (!meta) throw new ArtifactError(`No such artifact: ${id}`);
    if (!meta.written) throw new ArtifactError(`Artifact ${id} has no content yet`);

    const dir = destDir ?? defaultExportDir();
    mkdirSync(dir, { recursive: true });

    const name = artifactFileName(meta);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";

    let target = join(dir, name);
    for (let n = 2; existsSync(target); n++) {
        target = join(dir, `${stem}-${n}${ext}`);
        // A folder already holding thousands of these is a bug somewhere else;
        // failing loudly beats spinning.
        if (n > 1000) throw new ArtifactError(`Could not find a free filename in ${dir}`);
    }
    copyFileSync(artifactFilePath(meta), target);
    return target;
}
