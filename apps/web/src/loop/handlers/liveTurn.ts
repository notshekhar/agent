/**
 * The in-flight turn.
 *
 * loop persists a turn to its transcript only once the turn ends, so
 * `session.history` cannot show a reply as it is being written. The live text,
 * the thinking and the tool calls arrive instead as `session.event`
 * notifications, and this module is where they accumulate until the transcript
 * catches up.
 *
 * It is deliberately a plain observable store rather than anything Effect-
 * shaped: it is fed by a socket callback, read from a stream handler, and both
 * want the same mutable snapshot.
 */
import { onLoopEvent } from "../transport.ts";

export interface LiveToolCall {
  readonly id: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
  done: boolean;
}

export interface LiveTurn {
  /** Assistant text streamed so far this turn. */
  text: string;
  /** Reasoning streamed so far, concatenated across parts. */
  reasoning: string;
  /** Tool calls in the order loop reported them. */
  readonly tools: LiveToolCall[];
  /** Set when the turn ended with an error. */
  error?: string;
  running: boolean;
  /** Bumped on every mutation, so a reader can tell "changed" from "same". */
  revision: number;
  startedAt: string;
}

type Listener = (sessionId: string) => void;

const turns = new Map<string, LiveTurn>();
const listeners = new Set<Listener>();
let subscribed = false;

function emptyTurn(): LiveTurn {
  return {
    text: "",
    reasoning: "",
    tools: [],
    running: true,
    revision: 0,
    startedAt: new Date().toISOString(),
  };
}

function touch(sessionId: string, mutate: (turn: LiveTurn) => void): void {
  const existing = turns.get(sessionId) ?? emptyTurn();
  mutate(existing);
  existing.revision += 1;
  turns.set(sessionId, existing);
  for (const listener of listeners) listener(sessionId);
}

function toolFor(turn: LiveTurn, id: string): LiveToolCall {
  const found = turn.tools.find((tool) => tool.id === id);
  if (found) return found;
  const created: LiveToolCall = { id, name: "", input: undefined, done: false };
  turn.tools.push(created);
  return created;
}

/** Shape of one `session.event` notification's `part`. */
interface LoopTurnPart {
  readonly type: string;
  readonly data?: unknown;
}

function apply(sessionId: string, part: LoopTurnPart): void {
  const data = part.data as Record<string, unknown> | string | undefined;
  switch (part.type) {
    case "text-delta":
      touch(sessionId, (turn) => {
        turn.text += typeof data === "string" ? data : "";
      });
      return;
    case "reasoning-delta":
      touch(sessionId, (turn) => {
        turn.reasoning += typeof data === "string" ? data : "";
      });
      return;
    case "tool-input-start":
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; toolName?: string };
        if (!record?.toolCallId) return;
        toolFor(turn, record.toolCallId).name = record.toolName ?? "";
      });
      return;
    case "tool-call":
    case "tool-input-updated":
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; toolName?: string; input?: unknown };
        if (!record?.toolCallId) return;
        const tool = toolFor(turn, record.toolCallId);
        if (record.toolName) tool.name = record.toolName;
        tool.input = record.input;
      });
      return;
    case "tool-result":
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; output?: unknown };
        if (!record?.toolCallId) return;
        const tool = toolFor(turn, record.toolCallId);
        tool.output = record.output;
        tool.done = true;
      });
      return;
    case "tool-error":
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; toolName?: string; error?: unknown };
        if (!record?.toolCallId) return;
        const tool = toolFor(turn, record.toolCallId);
        if (record.toolName) tool.name = record.toolName;
        tool.error = record.error;
        tool.done = true;
      });
      return;
    case "error":
      touch(sessionId, (turn) => {
        turn.error = typeof data === "string" ? data : JSON.stringify(data);
        turn.running = false;
      });
      return;
    case "finish":
      // The transcript now has the whole turn, so the live copy stops being
      // the source of truth. It is kept (not deleted) until the next history
      // read replaces it, or the reply would blank out for a frame.
      touch(sessionId, (turn) => {
        turn.running = false;
      });
      return;
    default:
      return;
  }
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  onLoopEvent((event) => {
    const part = event.part as LoopTurnPart | undefined;
    if (!part || typeof part.type !== "string") return;
    apply(event.sessionId, part);
  });
}

/** Start a fresh live turn — called when a turn is dispatched. */
export function beginLiveTurn(sessionId: string): void {
  ensureSubscribed();
  turns.set(sessionId, emptyTurn());
  for (const listener of listeners) listener(sessionId);
}

/** The live turn for a session, if one has been seen. */
export function readLiveTurn(sessionId: string): LiveTurn | undefined {
  ensureSubscribed();
  return turns.get(sessionId);
}

/**
 * Drop the live turn once the transcript contains it. Called after a history
 * read that already includes the finished turn.
 */
export function clearLiveTurn(sessionId: string): void {
  turns.delete(sessionId);
}

/** Notified whenever any live turn changes. Returns an unsubscribe. */
export function onLiveTurnChange(listener: Listener): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
