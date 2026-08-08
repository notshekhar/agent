/**
 * The turn-end signal that cannot be missed.
 *
 * `finish` is emitted by the model stream; `session-running` is set in the RPC
 * server's `finally`. When a turn ends without the former — a dropped socket, a
 * resync past the event ring, an abort that unwound before the emitter ran —
 * the live turn stayed `running` forever, which is what pinned the composer on
 * Stop and the timeline on "Working for 12m" until the view was remounted.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  applyLoopEvent,
  beginLiveTurn,
  clearLiveTurn,
  readLiveTurn,
} from "../handlers/liveTurn.ts";

const globals = globalThis as { window?: Window & typeof globalThis };
globals.window ??= globals as unknown as Window & typeof globalThis;
window.loop ??= {
  call: () => Promise.resolve({}),
  onEvent: () => () => {},
  anchorCwd: () => Promise.resolve(undefined),
};

let seed = 0;
const session = () => `01RUNNING${(seed += 1)}`;

describe("loop's own running flag", () => {
  it("ends a turn whose finish never arrived", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "text-delta", data: "half an answer" });
    expect(readLiveTurn(id)?.running).toBe(true);

    // No `finish` — the turn simply stops being executed.
    applyLoopEvent(id, { type: "session-running", data: { running: false } });
    expect(readLiveTurn(id)?.running).toBe(false);
    clearLiveTurn(id);
  });

  it("leaves a running turn alone while the server still says running", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "session-running", data: { running: true } });
    expect(readLiveTurn(id)?.running).toBe(true);
    clearLiveTurn(id);
  });

  it("keeps the transcript the turn already produced", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "c1", toolName: "write" } });
    applyLoopEvent(id, { type: "tool-result", data: { toolCallId: "c1", output: "ok" } });
    applyLoopEvent(id, { type: "session-running", data: { running: false } });

    // Ending the turn must not blank the reply — the rows stay until the next
    // history read replaces them.
    const turn = readLiveTurn(id);
    expect(turn?.running).toBe(false);
    expect(turn?.tools.length).toBe(1);
    clearLiveTurn(id);
  });

  it("is inert once the turn has already closed", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "finish", data: {} });
    expect(readLiveTurn(id)?.running).toBe(false);
    // The pair normally arrive together; the second must be a no-op.
    applyLoopEvent(id, { type: "session-running", data: { running: false } });
    expect(readLiveTurn(id)?.running).toBe(false);
    clearLiveTurn(id);
  });
});
