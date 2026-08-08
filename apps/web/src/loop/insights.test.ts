/**
 * The insight readers, at the edges that actually bite: an older loop, and a
 * loop that answers with a number it should not be trusted on.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readCostStats, readSessionCost, readSteak } from "./insights.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

function withLoop(call: (method: string, params?: unknown) => Promise<unknown>) {
  globals.window ??= globals as unknown as Window & typeof globalThis;
  // Assigned through a widened view of `window`: `loop` is an optional
  // property and `exactOptionalPropertyTypes` rejects writing the bridge's own
  // `| undefined` back into it.
  (window as { loop?: unknown }).loop = {
    call: (method: string, params?: unknown) => call(method, params),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
  };
}

afterEach(() => {
  if (globals.window) delete window.loop;
});

describe("readSessionCost", () => {
  it("reports nothing rather than $0.00 for an all-zero breakdown", async () => {
    // MEASURED against loop 0.15.11: `cost.session` builds a fresh unseeded
    // tracker for a session this process has not run a turn in, so it answers
    // zero for a conversation that cost real money. `$0.0000` under the
    // session title is a confident lie; absence is the truth.
    withLoop(async () => ({
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    }));
    expect(await readSessionCost("s1")).toBeNull();
  });

  it("keeps a real breakdown, including the estimated flag", async () => {
    withLoop(async () => ({
      usd: 0.0364,
      inputTokens: 52_000,
      outputTokens: 665,
      cachedInputTokens: 43_000,
      estimated: true,
    }));
    expect(await readSessionCost("s1")).toMatchObject({ usd: 0.0364, estimated: true });
  });

  it("keeps a breakdown whose tokens are real but whose price is not known", async () => {
    // A model with no pricing in the catalog bills $0 against real tokens.
    // That is a fact about the catalog, not an empty session.
    withLoop(async () => ({
      usd: 0,
      inputTokens: 900,
      outputTokens: 12,
      cachedInputTokens: 0,
    }));
    expect(await readSessionCost("s1")).toMatchObject({ usd: 0, inputTokens: 900 });
  });

  it("survives a loop that does not have the method", async () => {
    withLoop(async () => {
      throw new Error("Method not found: cost.session");
    });
    expect(await readSessionCost("s1")).toBeNull();
  });
});

describe("the other readers degrade instead of throwing", () => {
  it("returns null for a malformed or missing answer", async () => {
    withLoop(async () => ({ nope: true }));
    expect(await readCostStats()).toBeNull();
    expect(await readSteak()).toBeNull();
  });

  it("passes cwd as a parameter, not only as the routing hint", async () => {
    // Over the Electron bridge the third argument only picks which `loop rpc`
    // process answers; `cost.stats` needs cwd as a param to fill in cwdUsd.
    let seen: unknown;
    withLoop(async (_method, params) => {
      seen = params;
      return { lifetimeUsd: 1, byProvider: {}, todayUsd: 0, last7Usd: 0, monthUsd: 0, cwdUsd: 1 };
    });
    await readCostStats("/w/project");
    expect(seen).toMatchObject({ cwd: "/w/project" });
  });
});
