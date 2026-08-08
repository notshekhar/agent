/**
 * The session tree — loop's `/tree`, `/fork` and `/clone`.
 *
 * A loop session is an append-only TREE, not a list: rewinding to an earlier
 * entry leaves everything after it as an abandoned branch that no longer
 * reaches the model but is still there to come back to. `session.history`
 * returns only the current branch, which is why none of this was visible in
 * the app — it is the right answer for drawing a conversation and the wrong
 * one for choosing between them.
 *
 * Reads degrade to null against a loop without these methods; the actions
 * throw, because "nothing happened" and "it failed" have to be told apart.
 */
import { supportsMethod } from "./capabilities.ts";
import { loopCall } from "./transport.ts";
import { notifyThreadChanged } from "./handlers/liveTurn.ts";

/** A tool call an entry made, for the row's one-line summary. */
export interface TreeRowTool {
  readonly name: string;
  readonly input: unknown;
}

export interface SessionTreeRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly ts: number;
  /** `message`, `compact`, `session-info`, `branch-summary`, … */
  readonly type: string;
  readonly role?: "user" | "assistant" | "tool";
  readonly text?: string;
  readonly truncated?: boolean;
  readonly tools?: readonly TreeRowTool[];
  readonly label?: string;
  /** How far to indent — NOT the tree depth. loop collapses single-child
   * chains so a linear conversation stays flat and only forks step in. */
  readonly indent: number;
  readonly depth: number;
  /** One of several siblings: where a branch visibly starts. */
  readonly branchStart?: boolean;
  readonly lastSibling?: boolean;
  /** On the branch the session is currently on — what the model sees. */
  readonly onPath: boolean;
  /** More than one child is a branch point: the only place navigating is a
   * choice rather than a jump. */
  readonly childCount: number;
  readonly interrupted?: boolean;
}

export interface SessionTreeView {
  readonly leafId: string | null;
  readonly rows: readonly SessionTreeRow[];
  readonly branchPointIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether this loop can do any of this at all.
 *
 * Asked before the control is drawn, not after the call fails: an older loop
 * answers `Method not found: session.tree`, and over the Electron bridge that
 * rejection prints a stack trace from `ipcMain.handle` on every attempt.
 */
export function supportsSessionTree(cwd?: string): Promise<boolean> {
  return supportsMethod("session.tree", cwd);
}

/** Every branch of a session. Null when loop is older than `session.tree`. */
export async function readSessionTree(
  sessionId: string,
  cwd?: string,
): Promise<SessionTreeView | null> {
  if (!(await supportsSessionTree(cwd))) return null;
  const view = await loopCall<unknown>("session.tree", { sessionId }, cwd).catch(() => null);
  if (!isRecord(view) || !Array.isArray(view.rows)) return null;
  return view as unknown as SessionTreeView;
}

/**
 * Move the session's leaf — loop's `/tree` navigation.
 *
 * `entryId: null` rewinds to the very beginning. Nothing is deleted: the
 * branch being left behind stays in the tree and can be navigated back to.
 * The thread stream is told directly because loop broadcasts nothing for this
 * — it is a client asking, not the agent acting — so without the notify the
 * transcript would keep rendering the branch that is no longer current.
 */
export async function branchSession(
  sessionId: string,
  entryId: string | null,
  cwd?: string,
): Promise<{ readonly leafId: string | null; readonly model?: string }> {
  const result = await loopCall<unknown>("session.branch", { sessionId, entryId }, cwd);
  notifyThreadChanged(sessionId);
  if (!isRecord(result)) throw new Error("loop did not report where the session moved to");
  return {
    leafId: typeof result.leafId === "string" ? result.leafId : null,
    ...(typeof result.model === "string" ? { model: result.model } : {}),
  };
}

export interface ForkedSession {
  readonly sessionId: string;
  readonly cwd: string;
  /** The forked-from prompt, when forking `before` — so a client can put it
   * back in its composer without a second round trip. */
  readonly text?: string;
}

/**
 * Copy a branch into a NEW session, leaving this one untouched.
 *
 * `at` clones up to and including the entry (loop's `/clone`); `before` forks
 * at a user message's parent so the message itself is not carried, which is
 * loop's `/fork` — you get the conversation up to that prompt, and the prompt
 * back in the composer to ask differently.
 */
export async function forkSession(
  sessionId: string,
  entryId: string,
  position: "at" | "before",
  cwd?: string,
): Promise<ForkedSession> {
  const result = await loopCall<unknown>(
    "session.fork",
    { sessionId, entryId, position },
    cwd,
  );
  if (!isRecord(result) || typeof result.sessionId !== "string") {
    throw new Error("loop did not report the forked session");
  }
  // The fork is a brand-new session loop knows about and the app does not.
  // Until the shell is rebuilt, `resolveThreadRouteRenderState` sees no shell
  // entry and no detail for it and renders the route as **missing** — which
  // is what "fork does nothing" looks like. loop broadcasts nothing here, so
  // the rebuild has to be asked for.
  notifyThreadChanged(result.sessionId);
  return {
    sessionId: result.sessionId,
    cwd: typeof result.cwd === "string" ? result.cwd : (cwd ?? ""),
    ...(typeof result.text === "string" && result.text !== "" ? { text: result.text } : {}),
  };
}
