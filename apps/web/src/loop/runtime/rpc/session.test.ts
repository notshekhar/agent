/**
 * PORTED FOR loop. Upstream's version of this file drove a fake WebSocket and
 * asserted the transport opened, closed and timed out correctly. There is no
 * WebSocket in the RPC path any more — the client is bound to handlers in this
 * process — so those assertions cannot hold, and the interesting question has
 * changed with them: not "did we dial correctly", but "does a session resolve
 * against loop without any transport at all".
 *
 * loop is faked at the one seam that exists for it, the `window.loop` desktop
 * bridge, which is also the shape the Electron shell has to implement.
 */
import { EnvironmentId } from "@loop/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcSession from "./session.ts";

const CWD = "/Users/someone/project";

interface BridgeCall {
  readonly method: string;
  readonly cwd: string | undefined;
}

/** Installs a fake loop and returns the calls it received. */
function installFakeLoop(
  responses: Record<string, unknown> = {},
): { calls: BridgeCall[]; restore: () => void } {
  const calls: BridgeCall[] = [];
  // The unit project runs in node, where the app's `window` does not exist.
  // The bridge lives on `window` because that is where a preload script puts
  // it, so the test supplies just enough of one.
  const globals = globalThis as { window?: Window & typeof globalThis };
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call(method, _params, cwd) {
      calls.push({ method, cwd });
      if (method in responses) return Promise.resolve(responses[method]);
      return Promise.reject(new Error(`unexpected loop call: ${method}`));
    },
    onEvent() {
      return () => {};
    },
    anchorCwd() {
      return Promise.resolve(CWD);
    },
  };
  return {
    calls,
    restore: () => {
      if (previous === undefined) delete window.loop;
      else window.loop = previous;
      if (!hadWindow) delete globals.window;
    },
  };
}

const connection: PreparedConnection = {
  environmentId: EnvironmentId.make("primary"),
  label: "loop",
  httpBaseUrl: "http://localhost/",
  socketUrl: "ws://localhost/ws",
  httpAuthorization: null,
  target: new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("primary"),
    label: "loop",
    httpBaseUrl: "http://localhost/",
    wsBaseUrl: "ws://localhost/",
  }),
};

const connectSession = Effect.gen(function* () {
  const factory = yield* RpcSession.make;
  return yield* factory.connect(connection);
});

describe("RpcSessionFactory", () => {
  it("resolves the config from loop, with no socket involved", async () => {
    const loop = installFakeLoop({
      "server.info": { defaults: { cwd: CWD, model: "kimi/k3" } },
      "catalog.list": [{ id: "kimi/k3", provider: "kimi", name: "K3", available: true }],
      "auth.status": { providers: ["kimi"], authorized: ["kimi"], active: "kimi" },
    });
    try {
      const config = await Effect.runPromise(
        Effect.scoped(
          connectSession.pipe(Effect.flatMap((session) => session.initialConfig)),
        ),
      );

      expect(config.cwd).toBe(CWD);
      expect(config.environment.environmentId).toBe("primary");
      expect(config.providers.map((provider) => provider.instanceId)).toEqual(["kimi"]);
      // The picker must offer loop's model, never upstream's codex default.
      expect(config.settings.textGenerationModelSelection).toEqual({
        instanceId: "kimi",
        model: "kimi/k3",
      });
      expect(loop.calls.map((call) => call.method).toSorted()).toEqual([
        "auth.status",
        "catalog.list",
        "server.info",
      ]);
    } finally {
      loop.restore();
    }
  });

  it("is ready as soon as it is connected, because there is nothing to dial", async () => {
    const loop = installFakeLoop({
      "server.info": {},
      "catalog.list": [],
      "auth.status": {},
    });
    try {
      await Effect.runPromise(
        Effect.scoped(connectSession.pipe(Effect.flatMap((session) => session.ready))),
      );
    } finally {
      loop.restore();
    }
  });

  it("probes without reaching for the network", async () => {
    const loop = installFakeLoop({
      "server.info": {},
      "catalog.list": [],
      "auth.status": {},
    });
    try {
      await Effect.runPromise(
        Effect.scoped(connectSession.pipe(Effect.flatMap((session) => session.probe))),
      );
    } finally {
      loop.restore();
    }
  });

  it("still produces a usable config when loop answers nothing", async () => {
    // Every input is best-effort: a loop that is up but has no catalog and no
    // credentials must still render an app, not a connection failure.
    const loop = installFakeLoop();
    try {
      const config = await Effect.runPromise(
        Effect.scoped(
          connectSession.pipe(Effect.flatMap((session) => session.initialConfig)),
        ),
      );
      expect(config.providers).toEqual([]);
      expect(config.environment.serverVersion.length).toBeGreaterThan(0);
    } finally {
      loop.restore();
    }
  });
});
