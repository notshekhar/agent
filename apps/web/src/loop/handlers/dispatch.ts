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

/** The loop session behind a thread id. Identity for anything from the shell. */
export function loopSessionIdFor(threadId: string): string {
  return bindings.get(threadId) ?? threadId;
}

export class UnsupportedCommandError extends Error {
  constructor(type: string) {
    super(`loop does not support the ${type} command`);
    this.name = "UnsupportedCommandError";
  }
}

/** Everything a `thread.create` needs to remember until the first turn. */
interface PendingThread {
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
}
const pending = new Map<string, PendingThread>();

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
      const sessionId = await ensureSession(command.threadId);
      // Begin the live turn BEFORE sending: loop can emit its first delta
      // while `session.send` is still in flight, and an event that arrives
      // before the buffer exists would be dropped.
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
