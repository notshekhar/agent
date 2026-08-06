import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { listEntries, readFile, searchEntries } from "./files.ts";
import type { LoopFilesystemBridge, WorkspaceEntry } from "../transport.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

function withFilesystem<T>(
  bridge: LoopFilesystemBridge | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: () => Promise.reject(new Error("not used")),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
    ...(bridge === undefined ? {} : { fs: bridge }),
  };
  return run().finally(() => {
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  });
}

const entries: WorkspaceEntry[] = [
  { path: "src", kind: "directory" },
  { path: "src/index.ts", kind: "file" },
  { path: "src/loop/handlers/files.ts", kind: "file" },
  { path: "README.md", kind: "file" },
];

const bridge = (over: Partial<LoopFilesystemBridge> = {}): LoopFilesystemBridge => ({
  list: () => Promise.resolve({ entries, truncated: false }),
  read: () =>
    Promise.resolve({
      ok: true,
      relativePath: "README.md",
      contents: "# hi",
      byteLength: 4,
      truncated: false,
    }),
  browse: () => Promise.resolve({ parentPath: "/w", entries: [] }),
  ...over,
});

describe("workspace files", () => {
  it("lists a project's entries", async () => {
    const result = await withFilesystem(bridge(), () =>
      Effect.runPromise(listEntries("/w/project")),
    );
    expect(result.entries).toHaveLength(4);
    expect(result.truncated).toBe(false);
  });

  it("fails with a reason in a browser rather than reporting an empty project", async () => {
    // An empty result here would read as "this project has no files", which is
    // a lie the user cannot diagnose.
    await expect(
      withFilesystem(undefined, () => Effect.runPromise(listEntries("/w/project"))),
    ).rejects.toThrow(/desktop app/);
  });

  it("matches a fuzzy subsequence, shortest path first", async () => {
    const result = await withFilesystem(bridge(), () =>
      Effect.runPromise(searchEntries({ cwd: "/w", query: "indexts", limit: 10 })),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual(["src/index.ts"]);
  });

  it("treats an empty query as a bounded browse", async () => {
    const result = await withFilesystem(bridge(), () =>
      Effect.runPromise(searchEntries({ cwd: "/w", query: "", limit: 2 })),
    );
    expect(result.entries).toHaveLength(2);
    // Hitting the limit is itself a truncation, or the picker shows two files
    // and implies that is all there is.
    expect(result.truncated).toBe(true);
  });

  it("filters by kind when the picker asks for folders", async () => {
    const result = await withFilesystem(bridge(), () =>
      Effect.runPromise(searchEntries({ cwd: "/w", query: "", limit: 10, kind: "directory" })),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual(["src"]);
  });

  it("surfaces the shell's refusal to read a file", async () => {
    await expect(
      withFilesystem(bridge({ read: () => Promise.resolve({ ok: false, failure: "binary_file" }) }), () =>
        Effect.runPromise(readFile({ cwd: "/w", relativePath: "a.png" })),
      ),
    ).rejects.toThrow(/binary_file/);
  });
});
