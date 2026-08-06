/**
 * Terminals, backed by real PTYs in the desktop shell.
 *
 * Same shape as the file handlers and for the same reason: loop's RPC has no
 * terminal and a browser cannot fork a shell, so this works in the desktop app
 * and fails with a reason elsewhere.
 *
 * Terminal ids are chosen by the renderer — the contract is explicit that there
 * is no server-side allocation — so every call here already knows which
 * terminal it means, and `open` on a live id reattaches rather than spawning a
 * second shell.
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  TerminalSessionSnapshot as TerminalSessionSnapshotSchema,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { loopPty, type TerminalOutput, type TerminalSnapshot } from "../transport.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(TerminalSessionSnapshotSchema);

const unavailable = () =>
  new EnvironmentAuthorizationError({
    message: "Terminals need loop's desktop app; the browser build cannot open a shell",
    requiredScope: AuthOrchestrationReadScope,
  });

const malformed = () =>
  new EnvironmentAuthorizationError({
    message: "The terminal returned an unexpected snapshot",
    requiredScope: AuthOrchestrationReadScope,
  });

const toContract = (snapshot: TerminalSnapshot) =>
  decodeSnapshot(snapshot).pipe(Effect.mapError(malformed));

export const openTerminal = Effect.fnUntraced(function* (input: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath?: string | null | undefined;
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
}) {
  const pty = loopPty();
  if (!pty) return yield* Effect.fail(unavailable());
  const snapshot = yield* Effect.promise(() =>
    pty.open({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      ...(input.cols === undefined ? {} : { cols: input.cols }),
      ...(input.rows === undefined ? {} : { rows: input.rows }),
    }),
  );
  return yield* toContract(snapshot);
});

export const writeTerminal = Effect.fnUntraced(function* (input: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly data: string;
}) {
  const pty = loopPty();
  if (!pty) return yield* Effect.fail(unavailable());
  yield* Effect.promise(() => pty.write(input.threadId, input.terminalId, input.data));
});

export const resizeTerminal = Effect.fnUntraced(function* (input: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
}) {
  const pty = loopPty();
  if (!pty) return yield* Effect.fail(unavailable());
  yield* Effect.promise(() =>
    pty.resize(input.threadId, input.terminalId, input.cols, input.rows),
  );
});

export const clearTerminal = Effect.fnUntraced(function* (input: {
  readonly threadId: string;
  readonly terminalId: string;
}) {
  const pty = loopPty();
  if (!pty) return yield* Effect.fail(unavailable());
  yield* Effect.promise(() => pty.clear(input.threadId, input.terminalId));
});

/** An absent terminalId means every terminal of the thread; see the contract. */
export const closeTerminal = Effect.fnUntraced(function* (input: {
  readonly threadId: string;
  readonly terminalId?: string | undefined;
}) {
  const pty = loopPty();
  if (!pty) return yield* Effect.fail(unavailable());
  yield* Effect.promise(() => pty.close(input.threadId, input.terminalId));
});

/** Output from every terminal, for the panel's global subscription. */
export function terminalEventStream(): Stream.Stream<TerminalEvent, EnvironmentAuthorizationError> {
  const pty = loopPty();
  // Idle rather than fail: this is opened when the panel mounts, not by an
  // action, and failing a connect-time subscription is how you lose a render.
  if (!pty) return Stream.never;
  return Stream.callback<TerminalEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        pty.onOutput((event) => {
          const mapped = toEvent(event);
          if (mapped) Queue.offerUnsafe(queue, mapped);
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ).pipe(Effect.asVoid),
  );
}

/**
 * The attach stream: the scrollback first, then live output.
 *
 * Ordering is the whole contract here — a client that received output before
 * the snapshot would paint the new bytes and then wipe them with the history.
 */
export function attachTerminal(input: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd?: string | undefined;
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
}): Stream.Stream<TerminalAttachStreamEvent, EnvironmentAuthorizationError> {
  const pty = loopPty();
  if (!pty) return Stream.fail(unavailable());

  const first = Effect.gen(function* () {
    const existing = yield* Effect.promise(() =>
      pty.snapshot(input.threadId, input.terminalId),
    );
    const snapshot =
      existing ??
      (yield* Effect.promise(() =>
        pty.open({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd ?? "",
          ...(input.cols === undefined ? {} : { cols: input.cols }),
          ...(input.rows === undefined ? {} : { rows: input.rows }),
        }),
      ));
    const decoded = yield* toContract(snapshot);
    return { type: "snapshot" as const, snapshot: decoded };
  });

  const live = Stream.callback<TerminalAttachStreamEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        pty.onOutput((event) => {
          if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) return;
          const mapped = toEvent(event);
          if (mapped) Queue.offerUnsafe(queue, mapped);
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ).pipe(Effect.asVoid),
  );

  return Stream.fromEffect(first).pipe(Stream.concat(live));
}

function toEvent(event: TerminalOutput): (TerminalEvent & TerminalAttachStreamEvent) | null {
  const base = { threadId: event.threadId, terminalId: event.terminalId };
  switch (event.type) {
    case "output":
      return { ...base, type: "output", data: event.data ?? "" } as TerminalEvent & TerminalAttachStreamEvent;
    case "exited":
      return {
        ...base,
        type: "exited",
        exitCode: event.exitCode ?? null,
        exitSignal: event.exitSignal ?? null,
      } as TerminalEvent & TerminalAttachStreamEvent;
    case "closed":
      return { ...base, type: "closed" } as TerminalEvent & TerminalAttachStreamEvent;
    default:
      return null;
  }
}
