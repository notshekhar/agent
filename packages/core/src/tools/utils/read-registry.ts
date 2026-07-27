/**
 * Read-before-edit enforcement (Claude Code behavior, enforced in the edit
 * tool itself instead of relying on the prompt):
 * - edit on a file never read this session → error telling the model to read first
 * - edit on a file changed on disk since it was read → error forcing a re-read
 * - write guards only existing files (overwrite needs a prior read); new
 *   files/paths pass freely.
 *
 * Reads also record *which lines* they covered. Any read is enough to edit —
 * edits match on exact text — but overwriting a file wholesale with write
 * requires having seen all of it: line 1 through EOF, which paginated reads
 * (offset=..., offset=..., …) accumulate to. Coverage resets when the file
 * changes on disk, since the old ranges describe content that's gone.
 *
 * In-memory and session-scoped: nothing persists to disk, and the registry
 * clears on /new. Subagent reads count — they share the session. Registries
 * are keyed by session id so concurrent sessions in one process (RPC) don't
 * see each other's reads; callers without a session share one default slate.
 */
import { statSync } from "node:fs";

type Range = [start: number, end: number]; // inclusive, 1-indexed lines

interface ReadRecord {
    /** File mtime as of when the content was read. */
    mtimeMs: number;
    /** Disjoint, sorted, merged line ranges seen this session. */
    covered: Range[];
    /** Some read ran to the end of the file. */
    sawEof: boolean;
}

const registries = new Map<string, Map<string, ReadRecord>>(); // session → (absolute path → read record)
const DEFAULT_KEY = "";

function registry(sessionId?: string): Map<string, ReadRecord> {
    const key = sessionId ?? DEFAULT_KEY;
    let r = registries.get(key);
    if (!r) {
        r = new Map();
        registries.set(key, r);
    }
    return r;
}

/** New session = clean slate; reads never carry across sessions. */
export function clearReadRegistry(sessionId?: string): void {
    if (sessionId === undefined) registries.clear();
    else registries.delete(sessionId);
}

/** Insert a range and merge anything it touches or bridges. */
function addRange(covered: Range[], range: Range): Range[] {
    const merged: Range[] = [];
    for (const [s, e] of [...covered, range].sort((a, b) => a[0] - b[0])) {
        if (merged.length === 0) {
            merged.push([s, e]);
            continue;
        }
        const last = merged[merged.length - 1];
        // Adjacent counts as contiguous: [1,50] plus [51,100] is [1,100].
        if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
    }
    return merged;
}

/** Coverage for a caller that didn't say what it read: assume the whole file. */
const WHOLE_FILE: Range = [1, Number.MAX_SAFE_INTEGER];

function isComplete(record: ReadRecord): boolean {
    return record.sawEof && record.covered.length === 1 && record.covered[0][0] === 1;
}

export interface RecordReadOptions {
    /**
     * mtime sampled *before* the content was read. Without it a write landing
     * mid-read would be recorded as already-seen, and a later edit would apply
     * to content the agent never saw.
     */
    mtimeMs?: number;
    /** Inclusive 1-indexed line range the agent actually saw. */
    range?: Range;
    /** The read ran to the end of the file. */
    sawEof?: boolean;
}

export function recordRead(absolutePath: string, sessionId?: string, options: RecordReadOptions = {}): void {
    try {
        const mtimeMs = options.mtimeMs ?? statSync(absolutePath).mtimeMs;
        const previous = registry(sessionId).get(absolutePath);
        // A changed file invalidates every range read from the old content.
        const base = previous && previous.mtimeMs === mtimeMs ? previous : undefined;
        const whole = options.range === undefined && options.sawEof === undefined;
        const range = whole ? WHOLE_FILE : options.range;
        registry(sessionId).set(absolutePath, {
            mtimeMs,
            covered: range ? addRange(base?.covered ?? [], range) : (base?.covered ?? []),
            sawEof: (base?.sawEof ?? false) || whole || (options.sawEof ?? false),
        });
    } catch {
        // unreadable stat — leave unrecorded
    }
}

/** Call after a successful edit/write so follow-up edits aren't flagged stale. */
export function recordModified(absolutePath: string, sessionId?: string): void {
    try {
        registry(sessionId).set(absolutePath, {
            mtimeMs: statSync(absolutePath).mtimeMs,
            covered: [[1, Number.MAX_SAFE_INTEGER]],
            sawEof: true,
        });
    } catch {
        // unreadable stat — leave unrecorded
    }
}

export interface ReadBeforeModifyOptions {
    /** Reject partial reads — for whole-file overwrites (write). */
    requireComplete?: boolean;
    /** Verb pair used in the error messages, e.g. ["write", "writing"]. */
    verb?: [imperative: string, gerund: string];
}

/** Returns an error message when the modification must be blocked, else null. */
export function checkReadBeforeModify(
    absolutePath: string,
    displayPath: string,
    sessionId?: string,
    options: ReadBeforeModifyOptions = {},
): string | null {
    const [verb, gerund] = options.verb ?? ["edit", "editing"];
    const record = registry(sessionId).get(absolutePath);
    if (record === undefined) {
        return `File has not been read in this session: ${displayPath}. Read it with the read tool first, then ${verb}.`;
    }
    try {
        if (statSync(absolutePath).mtimeMs > record.mtimeMs) {
            return `File changed on disk since it was read: ${displayPath}. Read it again before ${gerund}.`;
        }
    } catch {
        // stat failed (deleted?) — let the tool surface its own error
    }
    if (options.requireComplete && !isComplete(record)) {
        return `Only part of ${displayPath} has been read. Overwriting it wholesale needs the whole file: re-read it (continue with offset= until the end), or use edit for a targeted change.`;
    }
    return null;
}
