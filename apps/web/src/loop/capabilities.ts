/**
 * What this loop can actually do, asked once.
 *
 * `server.info` exists for exactly this — it is loop's capability handshake,
 * and its own comment says so: "lets a client discover the methods and event
 * types this server speaks without version-sniffing". The app was not using
 * it, so a newer UI against an older loop kept calling methods it could have
 * known were absent.
 *
 * That is not just wasted round trips. Over the Electron bridge a rejected
 * `loop:call` is an unhandled rejection inside an `ipcMain.handle`, so every
 * one printed a stack trace to the main-process log — the app worked, the
 * console said it was broken. Asking first means the calls are never made and
 * the controls behind them are simply absent, which is the honest rendering of
 * "this loop cannot do that".
 *
 * Fails OPEN: if `server.info` itself cannot be read, every method is assumed
 * present. A handshake that cannot be completed must not disable the app.
 */
import { loopCall } from "./transport.ts";

interface LoopServerInfo {
  readonly methods?: readonly string[];
  readonly events?: readonly string[];
}

/** One probe per folder — Electron runs a `loop rpc` per project. */
const probes = new Map<string, Promise<ReadonlySet<string> | null>>();

function probe(cwd?: string): Promise<ReadonlySet<string> | null> {
  const key = cwd ?? "";
  let pending = probes.get(key);
  if (!pending) {
    pending = loopCall<LoopServerInfo>("server.info", {}, cwd)
      .then((info) => (Array.isArray(info?.methods) ? new Set(info.methods) : null))
      .catch(() => null);
    probes.set(key, pending);
  }
  return pending;
}

/** Whether this loop serves a method. True when the handshake is unavailable. */
export async function supportsMethod(method: string, cwd?: string): Promise<boolean> {
  const methods = await probe(cwd);
  return methods === null || methods.has(method);
}

/**
 * Forget what was probed.
 *
 * The answer changes when the loop behind a folder is replaced — which is the
 * normal case here, since installing a rebuilt loop is how these methods
 * arrive. Called by nothing in the app today; a relaunch re-probes anyway.
 * Exported for tests, which must not inherit another test's server.
 */
export function resetCapabilityProbe(): void {
  probes.clear();
}
