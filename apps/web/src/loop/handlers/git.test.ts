import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { listRefs, refreshStatus } from "./git.ts";
import type { GitRef, GitStatus, LoopGitBridge } from "../transport.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

const ref = (name: string, over: Partial<GitRef> = {}): GitRef => ({
  name,
  isRemote: false,
  current: false,
  isDefault: false,
  worktreePath: null,
  ...over,
});

const status: GitStatus = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "desktop-app",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "src/a.ts", insertions: 3, deletions: 1 }],
    insertions: 3,
    deletions: 1,
  },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
};

function withGit<T>(bridge: LoopGitBridge | undefined, run: () => Promise<T>): Promise<T> {
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: () => Promise.reject(new Error("not used")),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
    ...(bridge === undefined ? {} : { git: bridge }),
  };
  return run().finally(() => {
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  });
}

const bridge = (refs: readonly GitRef[]): LoopGitBridge => ({
  refs: () =>
    Promise.resolve({ refs, isRepo: true, hasPrimaryRemote: true, totalCount: refs.length }),
  status: () => Promise.resolve(status),
});

describe("git", () => {
  it("puts the current branch first, then the default", async () => {
    // Otherwise the two branches anyone actually wants are buried in a list
    // that is alphabetical and often long.
    const result = await withGit(
      bridge([
        ref("zeta"),
        ref("main", { isDefault: true }),
        ref("alpha"),
        ref("desktop-app", { current: true }),
      ]),
      () => Effect.runPromise(listRefs({ cwd: "/w" })),
    );
    expect(result.refs.map((r) => r.name)).toEqual(["desktop-app", "main", "alpha", "zeta"]);
  });

  it("filters by kind and query", async () => {
    const refs = [ref("main"), ref("origin/main", { isRemote: true, remoteName: "origin" })];
    const remote = await withGit(bridge(refs), () =>
      Effect.runPromise(listRefs({ cwd: "/w", refKind: "remote" })),
    );
    expect(remote.refs.map((r) => r.name)).toEqual(["origin/main"]);

    const queried = await withGit(bridge([...refs, ref("feature/login")]), () =>
      Effect.runPromise(listRefs({ cwd: "/w", query: "LOG" })),
    );
    expect(queried.refs.map((r) => r.name)).toEqual(["feature/login"]);
  });

  it("reports 'not a repo' in a browser rather than failing", async () => {
    // The UI polls listRefs unprompted, so failing here is a retry storm the
    // user can see and cannot act on.
    const result = await withGit(undefined, () => Effect.runPromise(listRefs({ cwd: "/w" })));
    expect(result.isRepo).toBe(false);
    expect(result.refs).toEqual([]);
  });

  it("carries the working tree through to the status panel", async () => {
    const result = await withGit(bridge([]), () =>
      Effect.runPromise(refreshStatus({ cwd: "/w" })),
    );
    expect(result.refName).toBe("desktop-app");
    expect(result.hasWorkingTreeChanges).toBe(true);
    expect(result.workingTree.files[0]?.path).toBe("src/a.ts");
    expect(result.pr).toBeNull();
  });
});
