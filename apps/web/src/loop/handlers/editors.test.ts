import { EDITORS } from "@loop/contracts";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { detectEditors, openInEditor, resetEditorDetection } from "./editors.ts";
import type { LoopShellBridge } from "../transport.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

function withShell<T>(bridge: LoopShellBridge | undefined, run: () => Promise<T>): Promise<T> {
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: () => Promise.reject(new Error("not used")),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
    ...(bridge === undefined ? {} : { shell: bridge }),
  };
  return run().finally(() => {
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  });
}

/** A machine where only `installed` exists on PATH. */
const shellWith = (
  installed: readonly string[],
  log?: { launched: { command: string | null; args: readonly string[] }[] },
): LoopShellBridge => ({
  which: (commands) =>
    Promise.resolve(
      Object.fromEntries(
        commands.map((command) => [command, installed.includes(command) ? `/usr/bin/${command}` : null]),
      ),
    ),
  launch: (command, args) => {
    log?.launched.push({ command, args });
    return Promise.resolve({ ok: true as const });
  },
});

afterEach(() => resetEditorDetection());

describe("detecting editors", () => {
  it("reports only what is installed", async () => {
    const found = await withShell(shellWith(["code", "zed"]), () =>
      Effect.runPromise(detectEditors()),
    );

    expect(found).toContain("vscode");
    expect(found).toContain("zed");
    expect(found).not.toContain("cursor");
    expect(found).not.toContain("webstorm");
  });

  it("always offers the file manager, which is the OS and not an install", async () => {
    const found = await withShell(shellWith([]), () => Effect.runPromise(detectEditors()));
    expect(found).toEqual(["file-manager"]);
  });

  it("matches an editor on any of its command names", async () => {
    // Zed ships as `zed` or `zeditor` depending on how it was installed.
    const found = await withShell(shellWith(["zeditor"]), () =>
      Effect.runPromise(detectEditors()),
    );
    expect(found).toContain("zed");
  });

  it("probes once and reuses the answer", async () => {
    // The server config rebuilds on a 30s poll; re-probing two dozen commands
    // every time would spawn thousands of processes an hour.
    let calls = 0;
    const counting: LoopShellBridge = {
      which: (commands) => {
        calls += 1;
        return shellWith(["code"]).which(commands);
      },
      launch: () => Promise.resolve({ ok: true as const }),
    };

    await withShell(counting, async () => {
      await Effect.runPromise(detectEditors());
      await Effect.runPromise(detectEditors());
      await Effect.runPromise(detectEditors());
    });

    expect(calls).toBe(1);
  });

  it("reports nothing in a browser rather than offering an editor it cannot launch", async () => {
    const found = await withShell(undefined, () => Effect.runPromise(detectEditors()));
    expect(found).toEqual([]);
  });

  it("survives a probe that blows up", async () => {
    // The whole server config is waiting on this; it must not take it down.
    const broken: LoopShellBridge = {
      which: () => Promise.reject(new Error("spawn failed")),
      launch: () => Promise.resolve({ ok: true as const }),
    };
    const found = await withShell(broken, () => Effect.runPromise(detectEditors()));
    expect(found).toEqual(["file-manager"]);
  });
});

describe("opening an editor", () => {
  it("launches the editor's command with the target path", async () => {
    const log = { launched: [] as { command: string | null; args: readonly string[] }[] };
    await withShell(shellWith(["code"], log), () =>
      Effect.runPromise(openInEditor({ cwd: "/w/project/a.ts", editor: "vscode" })),
    );

    expect(log.launched).toEqual([{ command: "code", args: ["/w/project/a.ts"] }]);
  });

  it("passes an editor's own base arguments", async () => {
    // Kiro needs `kiro ide <path>`, not `kiro <path>`.
    const log = { launched: [] as { command: string | null; args: readonly string[] }[] };
    await withShell(shellWith(["kiro"], log), () =>
      Effect.runPromise(openInEditor({ cwd: "/w/project", editor: "kiro" })),
    );

    expect(log.launched[0]).toEqual({ command: "kiro", args: ["ide", "/w/project"] });
  });

  it("uses the file manager for the one entry that has no command", async () => {
    const log = { launched: [] as { command: string | null; args: readonly string[] }[] };
    await withShell(shellWith([], log), () =>
      Effect.runPromise(openInEditor({ cwd: "/w/project", editor: "file-manager" })),
    );

    // A null command tells the shell to use the OS opener.
    expect(log.launched[0]?.command).toBeNull();
  });

  it("says which command was missing when the editor is not installed", async () => {
    const failure = await withShell(shellWith([]), () =>
      Effect.runPromise(Effect.flip(openInEditor({ cwd: "/w", editor: "cursor" }))),
    );

    expect(failure._tag).toBe("ExternalLauncherCommandNotFoundError");
    expect(String(failure.message)).toContain("cursor");
  });

  it("reports a launch that failed", async () => {
    const failing: LoopShellBridge = {
      which: (commands) => shellWith(["code"]).which(commands),
      launch: () => Promise.resolve({ ok: false as const, error: "permission denied" }),
    };
    const failure = await withShell(failing, () =>
      Effect.runPromise(Effect.flip(openInEditor({ cwd: "/w", editor: "vscode" }))),
    );

    expect(failure._tag).toBe("ExternalLauncherEditorSpawnError");
  });

  it("covers every editor the contract offers", async () => {
    // The menu is drawn from EDITORS, so an entry this handler cannot launch
    // would be a dead row in the UI.
    const log = { launched: [] as { command: string | null; args: readonly string[] }[] };
    const all = EDITORS.flatMap((editor) => editor.commands ?? []);

    for (const editor of EDITORS) {
      await withShell(shellWith(all, log), () =>
        Effect.runPromise(openInEditor({ cwd: "/w", editor: editor.id })),
      );
    }

    expect(log.launched).toHaveLength(EDITORS.length);
  });
});
