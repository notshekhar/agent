/**
 * Read-before-edit enforcement (Claude Code behavior, enforced in the edit
 * tool itself instead of relying on the prompt):
 * - edit on a file never read this session → error telling the model to read first
 * - edit on a file changed on disk since it was read → error forcing a re-read
 * - write guards only existing files (overwrite needs a prior read); new
 *   files/paths pass freely.
 *
 * In-memory and session-scoped: nothing persists to disk, and the registry
 * clears on /new. Subagent reads count — they share the session. Registries
 * are keyed by session id so concurrent sessions in one process (RPC) don't
 * see each other's reads; callers without a session share one default slate.
 */
import { statSync } from "node:fs";

const registries = new Map<string, Map<string, number>>(); // session → (absolute path → mtimeMs when read)
const DEFAULT_KEY = "";

function registry(sessionId?: string): Map<string, number> {
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

export function recordRead(absolutePath: string, sessionId?: string): void {
    try {
        registry(sessionId).set(absolutePath, statSync(absolutePath).mtimeMs);
    } catch {
        // unreadable stat — leave unrecorded
    }
}

/** Call after a successful edit/write so follow-up edits aren't flagged stale. */
export function recordModified(absolutePath: string, sessionId?: string): void {
    recordRead(absolutePath, sessionId);
}

/** Returns an error message when the modification must be blocked, else null. */
export function checkReadBeforeModify(absolutePath: string, displayPath: string, sessionId?: string): string | null {
    const seenMtime = registry(sessionId).get(absolutePath);
    if (seenMtime === undefined) {
        return `File has not been read in this session: ${displayPath}. Read it with the read tool first, then edit.`;
    }
    try {
        if (statSync(absolutePath).mtimeMs > seenMtime) {
            return `File changed on disk since it was read: ${displayPath}. Read it again before editing.`;
        }
    } catch {
        // stat failed (deleted?) — let the tool surface its own error
    }
    return null;
}
