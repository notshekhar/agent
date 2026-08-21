/**
 * Naming the session, once, from its opening exchange.
 *
 * A session that is only a ULID and a cwd is unidentifiable the moment you
 * are not looking at it — which is exactly when something else is showing it
 * to you: a terminal tab, a cmux pane's sidebar card, a notification on a
 * phone. So the first turn earns a title, the title becomes the session's
 * name AND the terminal's title, and everything downstream inherits it for
 * free (cmux reads the terminal title for the pane's card, and `/sessions`
 * lists names).
 *
 * Deliberately once, and deliberately early: the opening exchange is what the
 * session is about, later turns drift, and a name that keeps changing is
 * worse than one that is slightly stale. A name the user set with `/name` is
 * never overwritten.
 */
import { generateSessionTitle } from "@notshekhar/loop-core";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";
import { traceEvent } from "./debug-log";

/** Sessions already titled in this process — one attempt each, ever. */
const attempted = new Set<string>();

/** OSC 0 is the tab's name in every terminal worth the word, cmux included. */
export function setTerminalTitle(deps: AppDeps, title: string): void {
    try {
        deps.tui.setTitle(title);
    } catch {
        // A terminal that refuses a title is not a reason to fail a turn.
    }
}

/**
 * Title the session if it hasn't been, then show it. Best-effort and
 * detached: callers must not await this, and every failure is silent — the
 * session simply keeps the identity it had.
 */
export async function maybeTitleSession(
    state: AppState,
    deps: AppDeps,
    turn: { userInput: string; assistantText: string; aborted: boolean },
): Promise<void> {
    const session = state.session;
    if (!session || turn.aborted) return;
    // An interrupted turn says nothing about the session's subject, and a
    // name the user chose outranks anything a model would pick.
    if (session.getName() || attempted.has(session.id)) return;
    if (!state.modelId) return;
    attempted.add(session.id);

    try {
        const title = await generateSessionTitle({
            userInput: turn.userInput,
            assistantText: turn.assistantText,
            modelId: state.modelId,
            tracker: deps.tracker,
            sessionPub: session.id,
            cwd: state.cwd,
        });
        if (!title) return;
        // The session may have been renamed, replaced (/new), or ended while
        // the model was thinking — check again before writing.
        if (state.session?.id !== session.id || session.getName()) return;
        await session.setName(title);
        setTerminalTitle(deps, title);
        traceEvent("session-title", title);
    } catch {
        // Best-effort by design: an unnamed session is a cosmetic loss.
    }
}
