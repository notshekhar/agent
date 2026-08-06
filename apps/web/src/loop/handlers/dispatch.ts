/**
 * Commands from the UI, executed against loop.
 *
 * The contract's command union has 20 members; loop can honestly serve the few
 * that correspond to something it does. The rest are rejected rather than
 * silently accepted — a command that returns a sequence number but changes
 * nothing is worse than one that visibly fails.
 *
 * The id problem, and why `bindings` exists: `thread.create` carries a
 * **client-chosen** `threadId`, but loop mints its own ULID in
 * `session.create`. Everywhere else a thread id IS a loop session id (that is
 * what the shell hands out), so the binding table only ever holds the short
 * window between a client creating a thread and loop naming it.
 */
import type { ClientOrchestrationCommand } from "@loop/contracts";
import * as Effect from "effect/Effect";

import { fromInstanceId } from "./ids.ts";
import { beginLiveTurn } from "./liveTurn.ts";
import { loopCall } from "../transport.ts";

/** client threadId -> loop sessionId, for threads this client created. */
const bindings = new Map<string, string>();

/** Everything a `thread.create` needs to remember until the first turn. */
interface PendingThread {
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
}
const pending = new Map<string, PendingThread>();


/** The loop session behind a thread id. Identity for anything from the shell. */
export function loopSessionIdFor(threadId: string): string {
  return bindings.get(threadId) ?? threadId;
}

/**
 * The reverse: the id the client knows a session by.
 *
 * This is what lets a draft finish becoming a thread. The draft route watches
 * the shell for a thread whose id matches the draft's own client-generated id,
 * and navigates when it appears. loop names the session something else
 * entirely, so a shell that reported loop's id would never satisfy that match
 * — the composer would sit on "Working" forever while the turn completed
 * perfectly well underneath.
 */
export function clientThreadIdFor(loopSessionId: string): string {
  for (const [threadId, sessionId] of bindings) {
    if (sessionId === loopSessionId) return threadId;
  }
  return loopSessionId;
}

/**
 * True while a thread exists only in the UI.
 *
 * The composer creates a draft as soon as it opens, with a client-generated
 * id, and loop is told nothing until the first turn. Anything that would ask
 * loop about such a thread has to check here first — loop answers "Unknown
 * sessionId", which is correct of it and useless to us.
 */
export function isDraftThread(threadId: string): boolean {
  return !bindings.has(threadId) && pending.has(threadId);
}

/** What `thread.create` recorded for a draft, if anything. */
export function draftIntent(threadId: string): PendingThread | undefined {
  return pending.get(threadId);
}

/**
 * The id the client gave the message it just sent.
 *
 * The client renders a user message optimistically the moment you hit send,
 * keyed by the `messageId` it minted. loop's transcript knows nothing of that
 * id, so a snapshot built from the transcript introduces a SECOND message with
 * the same text and a different id — the send appears twice. Remembering the
 * client's id lets the transcript reuse it, and the two collapse into one.
 *
 * Only the latest per session is kept: it exists to reconcile the message
 * still in flight, and older ones are already settled in the transcript.
 */
const lastUserMessage = new Map<string, { messageId: string; text: string }>();

export function recentUserMessageId(sessionId: string, text: string): string | undefined {
  const recent = lastUserMessage.get(sessionId);
  return recent && recent.text === text ? recent.messageId : undefined;
}

export class UnsupportedCommandError extends Error {
  constructor(type: string) {
    super(`loop does not support the ${type} command`);
    this.name = "UnsupportedCommandError";
  }
}

/**
 * loop creates a session lazily.
 *
 * `thread.create` is dispatched when the composer opens a draft, long before
 * the user commits to anything — creating a loop session there would litter
 * the sidebar with empty sessions every time someone clicked "New thread". So
 * the intent is recorded and the session is only minted on the first turn.
 */
async function ensureSession(threadId: string): Promise<string> {
  const bound = bindings.get(threadId);
  if (bound) return bound;

  // No recorded intent means this thread did not come from `thread.create` —
  // it came from the shell, where a thread id IS a loop session id. Creating
  // one here would fork the conversation into a brand new session and send
  // the turn somewhere the user is not looking.
  const intent = pending.get(threadId);
  if (!intent) return threadId;

  const created = await loopCall<{ sessionId: string }>(
    "session.create",
    { cwd: intent.cwd, provider: intent.provider, model: intent.model },
    intent.cwd,
  );
  bindings.set(threadId, created.sessionId);
  pending.delete(threadId);
  return created.sessionId;
}

export const dispatchCommand = Effect.fnUntraced(function* (command: ClientOrchestrationCommand) {
  return yield* Effect.promise(() => run(command));
});

async function run(command: ClientOrchestrationCommand): Promise<{ sequence: number }> {
  switch (command.type) {
    case "thread.create": {
      // The project id is the folder, so the workspace is already known.
      pending.set(command.threadId, {
        cwd: command.projectId,
        provider: fromInstanceId(command.modelSelection.instanceId),
        model: command.modelSelection.model,
      });
      return { sequence: 0 };
    }

    case "thread.turn.start": {
      const selection = command.modelSelection;
      // A draft's FIRST turn carries its own creation payload rather than
      // having been announced by an earlier `thread.create`. Measured the hard
      // way: without this the composer's first send reached loop with a
      // client-generated id, and loop rightly answered "Unknown sessionId".
      const bootstrap = command.bootstrap?.createThread;
      if (bootstrap && !bindings.has(command.threadId)) {
        pending.set(command.threadId, {
          cwd: bootstrap.projectId,
          provider: fromInstanceId(bootstrap.modelSelection.instanceId),
          model: bootstrap.modelSelection.model,
        });
      }
      const sessionId = await ensureSession(command.threadId);
      // Begin the live turn BEFORE sending: loop can emit its first delta
      // while `session.send` is still in flight, and an event that arrives
      // before the buffer exists would be dropped.
      lastUserMessage.set(sessionId, {
        messageId: command.message.messageId,
        text: command.message.text,
      });
      beginLiveTurn(sessionId);
      await loopCall("session.send", {
        sessionId,
        input: command.message.text,
        ...(selection === undefined ? {} : { model: selection.model }),
      });
      return { sequence: 0 };
    }

    case "thread.turn.interrupt": {
      await loopCall("session.cancel", { sessionId: loopSessionIdFor(command.threadId) });
      return { sequence: 0 };
    }

    case "thread.meta.update": {
      const title = command.title;
      if (typeof title === "string" && title.trim() !== "") {
        await loopCall("session.rename", {
          sessionId: loopSessionIdFor(command.threadId),
          name: title,
        });
      }
      return { sequence: 0 };
    }

    default:
      throw new UnsupportedCommandError(command.type);
  }
}
