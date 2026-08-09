import { describe, expect, it } from "vite-plus/test";

import type { GitFileChange, GitStatus } from "../../loop/transport";
import {
  canWriteIndex,
  groupChanges,
  hasIndexView,
  partitionForDiscard,
} from "./scmGroups";

function change(input: Partial<GitFileChange> & { path: string }): GitFileChange {
  return {
    indexStatus: null,
    worktreeStatus: null,
    staged: false,
    unstaged: false,
    untracked: false,
    stagedInsertions: 0,
    stagedDeletions: 0,
    unstagedInsertions: 0,
    unstagedDeletions: 0,
    ...input,
  };
}

describe("grouping changes", () => {
  it("puts a file that is staged and edited again into both groups, with each side's counts", () => {
    // The case the flat list could not express: one row could not say "these
    // two lines are in the next commit and this third one is not".
    const groups = groupChanges([
      change({
        path: "src/a.ts",
        indexStatus: "M",
        worktreeStatus: "M",
        staged: true,
        unstaged: true,
        stagedInsertions: 2,
        stagedDeletions: 1,
        unstagedInsertions: 5,
        unstagedDeletions: 0,
      }),
    ]);

    const staged = groups.find((group) => group.id === "staged");
    const unstaged = groups.find((group) => group.id === "unstaged");
    expect(staged?.rows[0]?.insertions).toBe(2);
    expect(staged?.rows[0]?.deletions).toBe(1);
    expect(unstaged?.rows[0]?.insertions).toBe(5);
    expect(unstaged?.rows[0]?.deletions).toBe(0);
    // Distinct keys, or React collapses the two rows into one.
    expect(staged?.rows[0]?.key).not.toBe(unstaged?.rows[0]?.key);
  });

  it("keeps a conflict out of both groups", () => {
    // Resolving is not staging; the actions on a conflict row are different
    // ones, so mixing it in would put buttons on a row that cannot honour them.
    const groups = groupChanges([
      change({ path: "src/war.ts", conflict: "both-modified", indexStatus: "U", worktreeStatus: "U" }),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["merge"]);
  });

  it("lists merge changes first", () => {
    const groups = groupChanges([
      change({ path: "b.ts", unstaged: true, worktreeStatus: "M" }),
      change({ path: "a.ts", staged: true, indexStatus: "M" }),
      change({ path: "c.ts", conflict: "both-added" }),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["merge", "staged", "unstaged"]);
  });

  it("drops empty groups rather than showing bare headers", () => {
    const groups = groupChanges([change({ path: "a.ts", unstaged: true, worktreeStatus: "M" })]);
    expect(groups.map((group) => group.id)).toEqual(["unstaged"]);
  });

  it("labels an untracked file U rather than leaving the badge blank", () => {
    // Porcelain reports no status letters for untracked files at all.
    const groups = groupChanges([change({ path: "new.ts", untracked: true, unstaged: true })]);
    expect(groups[0]?.rows[0]?.letter).toBe("U");
  });

  it("shows each side's own status letter", () => {
    const groups = groupChanges([
      change({
        path: "renamed.ts",
        indexStatus: "R",
        worktreeStatus: "M",
        staged: true,
        unstaged: true,
      }),
    ]);
    expect(groups.find((group) => group.id === "staged")?.rows[0]?.letter).toBe("R");
    expect(groups.find((group) => group.id === "unstaged")?.rows[0]?.letter).toBe("M");
  });

  it("sorts by path so the list does not reshuffle between polls", () => {
    const groups = groupChanges([
      change({ path: "z.ts", unstaged: true }),
      change({ path: "a.ts", unstaged: true }),
      change({ path: "m.ts", unstaged: true }),
    ]);
    expect(groups[0]?.rows.map((row) => row.change.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

describe("discarding", () => {
  it("separates untracked files, which cannot be restored", () => {
    // `git restore` needs an index entry; an untracked file has none, so handing
    // every path to one command would silently skip them.
    const groups = groupChanges([
      change({ path: "tracked.ts", unstaged: true, worktreeStatus: "M" }),
      change({ path: "junk.ts", untracked: true, unstaged: true }),
    ]);
    const { tracked, untracked } = partitionForDiscard(groups[0]!.rows);
    expect(tracked).toEqual(["tracked.ts"]);
    expect(untracked).toEqual(["junk.ts"]);
  });
});

describe("availability", () => {
  it("requires every write method before showing controls", () => {
    // A missing method must read as "not available here", not as a TypeError
    // inside a click handler.
    expect(canWriteIndex(null)).toBe(false);
    expect(canWriteIndex({})).toBe(false);
    expect(canWriteIndex({ stage: () => {}, unstage: () => {} })).toBe(false);
    expect(canWriteIndex({ stage: () => {}, unstage: () => {}, discard: () => {} })).toBe(true);
  });

  it("has no index view for a folder of repositories", () => {
    // Staging is an operation on one index and this folder has none; it gets a
    // repository list instead, each entry driving its own panel.
    const workspace = {
      isRepo: true,
      isWorkspaceRoot: true,
      changes: [],
    } as unknown as GitStatus;
    expect(hasIndexView(workspace)).toBe(false);
  });

  it("has no index view on a shell too old to report changes", () => {
    const older = { isRepo: true } as unknown as GitStatus;
    expect(hasIndexView(older)).toBe(false);
    expect(hasIndexView(null)).toBe(false);
  });

  it("has an index view for an ordinary repository", () => {
    const repo = { isRepo: true, changes: [] } as unknown as GitStatus;
    expect(hasIndexView(repo)).toBe(true);
  });
});
