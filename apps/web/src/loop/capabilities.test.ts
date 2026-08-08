/**
 * The capability handshake, and the two ways it must not go wrong: it must
 * stop calls an older loop cannot serve, and it must never disable the app
 * because it could not ask.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resetCapabilityProbe, supportsMethod } from "./capabilities.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

function withLoop(call: (method: string) => Promise<unknown>) {
  globals.window ??= globals as unknown as Window & typeof globalThis;
  (window as { loop?: unknown }).loop = {
    call: (method: string) => call(method),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
  };
}

afterEach(() => {
  resetCapabilityProbe();
  if (globals.window) delete window.loop;
});

describe("supportsMethod", () => {
  it("answers from loop's own method list", async () => {
    withLoop(async () => ({ methods: ["session.list", "session.history"] }));
    expect(await supportsMethod("session.list")).toBe(true);
    expect(await supportsMethod("session.tree")).toBe(false);
  });

  it("asks once per folder", async () => {
    // Electron runs a `loop rpc` per project, so the answer is per folder —
    // but three controls asking the same folder is one round trip.
    let calls = 0;
    withLoop(async () => {
      calls += 1;
      return { methods: ["session.tree"] };
    });
    await Promise.all([
      supportsMethod("session.tree", "/w/a"),
      supportsMethod("session.branch", "/w/a"),
      supportsMethod("session.tree", "/w/a"),
    ]);
    expect(calls).toBe(1);
    await supportsMethod("session.tree", "/w/b");
    expect(calls).toBe(2);
  });

  it("fails OPEN when the handshake itself cannot be read", async () => {
    // A loop that cannot answer `server.info` is not a loop that can do
    // nothing — assuming the worst would switch the whole UI off.
    withLoop(async () => {
      throw new Error("socket closed");
    });
    expect(await supportsMethod("session.tree")).toBe(true);
  });

  it("fails open on a malformed answer too", async () => {
    withLoop(async () => ({ methods: "not-an-array" }));
    expect(await supportsMethod("session.tree")).toBe(true);
  });
});
