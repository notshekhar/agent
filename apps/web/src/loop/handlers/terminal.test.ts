import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { attachTerminal, openTerminal, terminalEventStream } from "./terminal.ts";
import type { LoopPtyBridge, TerminalOutput, TerminalSnapshot } from "../transport.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

const snapshot: TerminalSnapshot = {
  threadId: "t1",
  terminalId: "a",
  cwd: "/w/project",
  worktreePath: null,
  status: "running",
  pid: 4242,
  history: "$ echo hi\nhi\n",
  exitCode: null,
  exitSignal: null,
  label: "project",
  updatedAt: "2026-08-06T00:00:00.000Z",
  sequence: 2,
};

function withPty<T>(bridge: LoopPtyBridge | undefined, run: () => Promise<T>): Promise<T> {
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: () => Promise.reject(new Error("not used")),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
    ...(bridge === undefined ? {} : { pty: bridge }),
  };
  return run().finally(() => {
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  });
}

const bridge = (over: Partial<LoopPtyBridge> = {}): LoopPtyBridge => ({
  open: () => Promise.resolve(snapshot),
  snapshot: () => Promise.resolve(snapshot),
  write: () => Promise.resolve(),
  resize: () => Promise.resolve(),
  clear: () => Promise.resolve(),
  close: () => Promise.resolve(),
  onOutput: () => () => {},
  ...over,
});

describe("terminals", () => {
  it("opens a shell and returns a contract-shaped snapshot", async () => {
    const result = await withPty(bridge(), () =>
      Effect.runPromise(
        openTerminal({ threadId: "t1", terminalId: "a", cwd: "/w/project", cols: 80, rows: 24 }),
      ),
    );
    expect(result.pid).toBe(4242);
    expect(result.status).toBe("running");
  });

  it("says so in a browser rather than opening nothing", async () => {
    await expect(
      withPty(undefined, () =>
        Effect.runPromise(openTerminal({ threadId: "t1", terminalId: "a", cwd: "/w" })),
      ),
    ).rejects.toThrow(/desktop app/);
  });

  it("sends the scrollback first, carrying the history", async () => {
    // If output came first the client would paint new bytes and then wipe them
    // with the history.
    const first = await withPty(bridge(), () =>
      Effect.runPromise(
        Effect.scoped(
          Stream.runCollect(Stream.take(attachTerminal({ threadId: "t1", terminalId: "a" }), 1)),
        ),
      ),
    );
    const items = [...first] as Array<{ type: string; snapshot?: { history: string } }>;
    expect(items[0]?.type).toBe("snapshot");
    expect(items[0]?.snapshot?.history).toContain("echo hi");
  });

  it("forwards live output for its own terminal only", async () => {
    // An array rather than a nullable local: assigning inside the callback
    // narrows the local to never, and the emit calls below stop typechecking.
    const emitters: Array<(event: TerminalOutput) => void> = [];
    const stream = await withPty(
      bridge({
        onOutput: (listener) => {
          emitters.push(listener);
          return () => {};
        },
      }),
      async () => attachTerminal({ threadId: "t1", terminalId: "a" }),
    );
    // Driven with plain promises rather than fibers: the stream must be
    // running before anything is emitted, and a sleep on the outside is the
    // clearest way to guarantee that ordering.
    const seen: Array<{ type: string; data?: string }> = [];
    const draining = Effect.runPromise(
      Effect.scoped(
        Stream.runForEach(Stream.take(stream, 2), (item) =>
          Effect.sync(() => {
            seen.push(item as { type: string; data?: string });
          }),
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    // A different terminal must not leak into this one.
    for (const emit of emitters) {
      emit({ threadId: "t1", terminalId: "other", type: "output", data: "nope" });
      emit({ threadId: "t1", terminalId: "a", type: "output", data: "mine" });
    }
    await draining;
    const items = seen;
    expect(items.map((item) => item.type)).toEqual(["snapshot", "output"]);
    expect(items[1]?.data).toBe("mine");
  });

  /**
   * The gap between the snapshot and the live subscription.
   *
   * `attachTerminal` used to read the snapshot and only THEN subscribe, so
   * everything the shell wrote in between was dropped on the floor — and what
   * a shell writes in exactly that window is its first prompt. Whether the
   * terminal came up blank depended on whether zsh beat an IPC round trip,
   * which is why it worked some of the time.
   *
   * The emit rides on the snapshot promise's own `.then`, so it lands after
   * the snapshot is resolved and before anything downstream of it can run —
   * the gap, deterministically, with no sleeps to tune.
   */
  it("keeps output written while the snapshot is still in flight", async () => {
    const listeners = new Set<(event: TerminalOutput) => void>();
    // A shell that has written nothing yet: empty history, sequence 0.
    const fresh = { ...snapshot, history: "", sequence: 0 };
    const seen: Array<{ type: string; data?: string }> = [];

    await withPty(
      bridge({
        snapshot: () => {
          const pending = Promise.resolve(fresh);
          void pending.then(() => {
            for (const listener of listeners) {
              listener({
                threadId: "t1",
                terminalId: "a",
                type: "output",
                data: "prompt$ ",
                // The first chunk, written after that snapshot was taken.
                sequence: 1,
              });
            }
          });
          return pending;
        },
        onOutput: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
      () =>
        Effect.runPromise(
          attachTerminal({ threadId: "t1", terminalId: "a" }).pipe(
            Stream.runForEach((item) =>
              Effect.sync(() => {
                seen.push(item as { type: string; data?: string });
              }),
            ),
            Effect.scoped,
            // The stream stays open for live output, so collect a window of it.
            Effect.timeout("300 millis"),
            Effect.ignore,
          ),
        ),
    );

    expect(seen.map((item) => item.type)).toEqual(["snapshot", "output"]);
    expect(seen[1]?.data).toBe("prompt$ ");
  });

  /**
   * The other half of subscribing first: some of what gets buffered is already
   * inside the snapshot's `history`, because the shell wrote it before the
   * snapshot was taken. Replaying those would paint the prompt twice.
   */
  it("drops buffered chunks the snapshot's history already covers", async () => {
    const listeners = new Set<(event: TerminalOutput) => void>();
    const seen: Array<{ type: string; data?: string }> = [];
    // `snapshot.history` is "$ echo hi\nhi\n" and its sequence is 2, so those
    // two chunks are accounted for; only the third is new.
    const replayed: TerminalOutput[] = [
      { threadId: "t1", terminalId: "a", type: "output", data: "$ echo hi\n", sequence: 1 },
      { threadId: "t1", terminalId: "a", type: "output", data: "hi\n", sequence: 2 },
      { threadId: "t1", terminalId: "a", type: "output", data: "$ ", sequence: 3 },
    ];

    await withPty(
      bridge({
        snapshot: () => {
          const pending = Promise.resolve(snapshot);
          void pending.then(() => {
            for (const listener of listeners) for (const event of replayed) listener(event);
          });
          return pending;
        },
        onOutput: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
      () =>
        Effect.runPromise(
          attachTerminal({ threadId: "t1", terminalId: "a" }).pipe(
            Stream.runForEach((item) =>
              Effect.sync(() => {
                seen.push(item as { type: string; data?: string });
              }),
            ),
            Effect.scoped,
            Effect.timeout("300 millis"),
            Effect.ignore,
          ),
        ),
    );

    expect(seen.map((item) => item.type)).toEqual(["snapshot", "output"]);
    expect(seen[1]?.data).toBe("$ ");
  });

  /**
   * A shell that dies and respawns during the gap restarts its own count, so
   * the boundary has to move with it. Measured against the dead session's
   * total, the new shell's chunks all look old and get discarded — the blank
   * pane again, by a longer route.
   */
  it("re-bases the boundary when a shell restarts mid-attach", async () => {
    const listeners = new Set<(event: TerminalOutput) => void>();
    const seen: Array<{ type: string; data?: string }> = [];
    const restarted = { ...snapshot, history: "", sequence: 0 };
    const duringGap: TerminalOutput[] = [
      { threadId: "t1", terminalId: "a", type: "started", snapshot: restarted },
      { threadId: "t1", terminalId: "a", type: "output", data: "fresh$ ", sequence: 1 },
    ];

    await withPty(
      bridge({
        // The old session's snapshot: sequence 2, already ahead of the new
        // shell's chunk numbering.
        snapshot: () => {
          const pending = Promise.resolve(snapshot);
          void pending.then(() => {
            for (const listener of listeners) for (const event of duringGap) listener(event);
          });
          return pending;
        },
        onOutput: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
      () =>
        Effect.runPromise(
          attachTerminal({ threadId: "t1", terminalId: "a" }).pipe(
            Stream.runForEach((item) =>
              Effect.sync(() => {
                seen.push(item as { type: string; data?: string });
              }),
            ),
            Effect.scoped,
            Effect.timeout("300 millis"),
            Effect.ignore,
          ),
        ),
    );

    // The restart replaces the buffer, and the new shell's prompt survives.
    expect(seen.map((item) => item.type)).toEqual(["snapshot", "snapshot", "output"]);
    expect(seen[2]?.data).toBe("fresh$ ");
  });

  it("idles rather than failing when the panel mounts in a browser", async () => {
    // A connect-time subscription that fails takes the render down with it.
    const stream = await withPty(undefined, async () => terminalEventStream());
    const drained = await Effect.runPromise(
      Effect.scoped(
        Effect.raceFirst(
          Stream.runCollect(Stream.take(stream, 1)).pipe(Effect.as("emitted")),
          Effect.sleep("80 millis").pipe(Effect.as("idled")),
        ),
      ),
    );
    expect(drained).toBe("idled");
  });
});
