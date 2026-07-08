import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { debugLog } from "../debug";
import type { Entry } from "../types";
import { getSessionStore } from "./sqlite-store";

/**
 * Sessions live in SQLite, but hooks receive a `transcript_path` in the
 * historical JSONL shape (Claude Code compatibility) — and hooks commonly
 * read that file. This module makes the path real: when a hook is about to
 * run, the session's entries are serialized to the path on demand. Lazy by
 * design — no hooks configured means no file is ever written.
 */

/** One entry per line — the session's canonical JSONL serialization. */
export function sessionToJsonl(entries: Entry[]): string {
    return entries.map((e) => JSON.stringify(e)).join("\n");
}

/**
 * Skip rewriting a transcript whose entries haven't changed since the last
 * materialization. Count alone misses /compact's replaceEntries (same-count
 * rewrites), so the last entry's pub id is checked too.
 */
const written = new Map<string, { count: number; lastId: string | undefined }>();

/** Test seam: forget what was written so staleness starts fresh. */
export function resetTranscriptCache(): void {
    written.clear();
}

/**
 * Write the session's entries as JSONL to its public transcript path, so a
 * hook reading `transcript_path` sees the real, current conversation. The
 * session id is parsed from the path's basename (the `<id>.jsonl` shape the
 * manager mints). Unknown sessions and I/O failures degrade to a debug log —
 * a transcript write must never break a turn.
 */
export function materializeTranscript(path: string): void {
    try {
        if (!path.endsWith(".jsonl")) return;
        const id = basename(path).replace(/\.jsonl$/, "");
        const record = getSessionStore().getSession(id);
        if (!record) return;
        const entries = getSessionStore().loadEntries(record.rowId);
        const stat = { count: entries.length, lastId: entries[entries.length - 1]?.id };
        const prev = written.get(path);
        if (prev && prev.count === stat.count && prev.lastId === stat.lastId) return;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, sessionToJsonl(entries));
        written.set(path, stat);
    } catch (err) {
        debugLog("transcript", `materialize failed for ${path}:`, err);
    }
}
