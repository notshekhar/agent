/**
 * When a post-turn recap is allowed to run.
 *
 * A recap summarises a turn the user has just watched happen, and it costs a
 * second model call to write. Both of those stop being true the moment the
 * user replies: they have moved on, the summary of what they moved past is
 * worth nothing, and we paid for it anyway.
 *
 * Worse, it was actively wrong on screen. `runRecap` is detached so the prompt
 * frees immediately (turn.ts), so its entry is appended whenever generation
 * happens to finish — and a user who answers quickly gets that entry written
 * AFTER the next turn's user message. The transcript is walked in entry order,
 * so the recap for turn N renders below the question that started turn N+1.
 *
 * So the recap waits, per session, and the next turn cancels it. Quiet users
 * get their recap; fast ones get none, which is both cheaper and the only
 * ordering that was ever correct.
 *
 * The entry stays registered THROUGH generation, not just the wait, because
 * cancelling only during the wait would leave the same bug in a smaller window:
 * the timer fires, generation takes a few seconds, and the append still lands
 * after the newer user message.
 */

/** How long a turn must go unanswered before its recap is worth writing. */
export const RECAP_DELAY_MS = 15_000;

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; abort: AbortController }>();

/**
 * Drop this session's recap, whether it is waiting or already generating.
 *
 * Called at the top of every turn, so every caller — the CLI, the RPC server's
 * `session.send`, queued turns, steering — inherits it without knowing it
 * exists.
 */
export function cancelRecap(sessionId: string): void {
    const entry = pending.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.abort.abort();
    pending.delete(sessionId);
}

/**
 * Run `run` for this session once the delay passes uninterrupted.
 *
 * `run` receives the signal that `cancelRecap` aborts; it is expected to check
 * it before writing anything, since a generation can resolve normally a moment
 * before the abort lands.
 */
export function scheduleRecap(
    sessionId: string,
    run: (signal: AbortSignal) => Promise<void>,
    delayMs: number = RECAP_DELAY_MS,
): void {
    // A newer turn supersedes an older pending recap rather than racing it.
    cancelRecap(sessionId);
    const abort = new AbortController();
    const timer = setTimeout(() => {
        void run(abort.signal).finally(() => {
            // Identity-checked: a slow recap must not evict the entry belonging
            // to a newer one that replaced it while this was still running.
            if (pending.get(sessionId)?.abort === abort) pending.delete(sessionId);
        });
    }, delayMs);
    // A pending recap must never be the reason a process stays alive — `loop
    // run` would otherwise sit idle for the whole delay after every turn that
    // touched a file. One-shot runs exit before the delay and write no recap,
    // which is the right trade: nobody is watching that transcript.
    timer.unref?.();
    pending.set(sessionId, { timer, abort });
}

/** Test seam: forget every pending recap without running any of them. */
export function clearAllPendingRecaps(): void {
    for (const sessionId of [...pending.keys()]) cancelRecap(sessionId);
}
