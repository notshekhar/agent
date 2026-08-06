import { describe, expect, it } from "vite-plus/test";

import { loopCall } from "../../loop/transport";

const globals = globalThis as { window?: Window & typeof globalThis };

/**
 * The rollback behaviour matters more than the happy path: a switch that stays
 * flipped after loop refused the write tells the user something false about
 * their own config. The hook itself needs React to exercise, so this drives
 * the same transport contract the hook is built on.
 */
function withLoop(
  handler: (method: string, params: unknown) => Promise<unknown>,
): { calls: Array<{ method: string; params: unknown }>; restore: () => void } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: (method, params) => {
      calls.push({ method, params });
      return handler(method, params);
    },
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
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

describe("loop settings over the transport", () => {
  it("sends the key loop knows, not the label the user sees", async () => {
    // loop's allowlist labels `webSearch` as "websearch"; writing the label
    // back would be rejected as an unknown setting.
    const loop = withLoop(() => Promise.resolve({ key: "webSearch", value: false }));
    try {
      await loopCall("settings.set", { key: "webSearch", value: false });
      expect(loop.calls).toEqual([
        { method: "settings.set", params: { key: "webSearch", value: false } },
      ]);
    } finally {
      loop.restore();
    }
  });

  it("surfaces loop's refusal rather than swallowing it", async () => {
    const loop = withLoop(() => Promise.reject(new Error("setting not writable over RPC: theme")));
    try {
      await expect(loopCall("settings.set", { key: "theme", value: true })).rejects.toThrow(
        "not writable over RPC",
      );
    } finally {
      loop.restore();
    }
  });

  it("reads settings and extensions as separate calls", async () => {
    const loop = withLoop((method) =>
      Promise.resolve(
        method === "settings.list"
          ? [{ key: "webSearch", label: "websearch", description: "", value: true }]
          : [{ name: "lsp", enabled: true, builtin: true }],
      ),
    );
    try {
      const settings = await loopCall<readonly { key: string }[]>("settings.list");
      const extensions = await loopCall<readonly { name: string }[]>("extension.list");
      expect(settings[0]?.key).toBe("webSearch");
      expect(extensions[0]?.name).toBe("lsp");
    } finally {
      loop.restore();
    }
  });
});
