import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { listEntries, readFile, searchEntries, writeFile } from "./files.ts";
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

/**
 * Saving.
 *
 * The editor's save loop only clears its "unsaved" mark when the write
 * SUCCEEDS, so every failure here is visible to the user as a tab that never
 * stops looking dirty. This handler was a stub that always failed, which is
 * exactly what that dot was reporting.
 */
describe("saving a file", () => {
  it("writes through the bridge and returns the path that was written", async () => {
    const seen: Array<[string, string, string]> = [];
    const result = await withFilesystem(
      bridge({
        write: (cwd, relativePath, contents) => {
          seen.push([cwd, relativePath, contents]);
          return Promise.resolve({ ok: true, relativePath });
        },
      }),
      () =>
        Effect.runPromise(
          writeFile({ cwd: "/w", relativePath: "README.md", contents: "# edited" }),
        ),
    );
    expect(seen).toEqual([["/w", "README.md", "# edited"]]);
    expect(result.relativePath).toBe("README.md");
  });

  /**
   * The shell may write somewhere other than the path asked for, when the
   * request repeated the tail of the workspace root. The caller keys its cache
   * by what comes back, so the RESOLVED path has to be what it gets.
   */
  it("reports the resolved path, not the requested one", async () => {
    const result = await withFilesystem(
      bridge({ write: () => Promise.resolve({ ok: true, relativePath: "x.md" }) }),
      () =>
        Effect.runPromise(
          writeFile({ cwd: "/w/stories", relativePath: "stories/x.md", contents: "hi" }),
        ),
    );
    expect(result.relativePath).toBe("x.md");
  });

  it("surfaces the shell's reason when the write is refused", async () => {
    await expect(
      withFilesystem(
        bridge({
          write: () => Promise.resolve({ ok: false, failure: "resolved_path_outside_root" }),
        }),
        () =>
          Effect.runPromise(
            writeFile({ cwd: "/w", relativePath: "../nope", contents: "x" }),
          ),
      ),
    ).rejects.toThrow(/resolved_path_outside_root/);
  });

  it("says so in a browser rather than pretending to save", async () => {
    await expect(
      withFilesystem(undefined, () =>
        Effect.runPromise(writeFile({ cwd: "/w", relativePath: "a.md", contents: "x" })),
      ),
    ).rejects.toThrow(/desktop app/);
  });

  /** An older shell has `fs` but no `write`; that must fail, not throw a TypeError. */
  it("says so when the shell is too old to write", async () => {
    await expect(
      withFilesystem(bridge(), () =>
        Effect.runPromise(writeFile({ cwd: "/w", relativePath: "a.md", contents: "x" })),
      ),
    ).rejects.toThrow(/desktop app/);
  });
});
