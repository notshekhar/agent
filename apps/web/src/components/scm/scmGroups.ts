import type { GitConflictKind, GitFileChange, GitStatus } from "../../loop/transport";

/**
 * The rows the source-control panel draws, derived from a repository's status.
 *
 * Pure and separate from the component for the usual reason — this is where the
 * decisions live, and they are worth asserting directly rather than through a
 * rendered tree. Group membership is not a formatting detail: putting a file in
 * the wrong one means offering an action that would do something other than
 * what its label says.
 */

export type ScmGroupId = "merge" | "staged" | "unstaged";

export interface ScmRow {
  readonly change: GitFileChange;
  /** Which side of the file this row represents. */
  readonly group: ScmGroupId;
  /** `M`, `A`, `D`… for the badge — the letter for THIS row's side. */
  readonly letter: string;
  readonly insertions: number;
  readonly deletions: number;
  /** Stable across groups, so React keys never collide for an `MM` file. */
  readonly key: string;
}

export interface ScmGroup {
  readonly id: ScmGroupId;
  readonly title: string;
  readonly rows: readonly ScmRow[];
}

/** How a conflict reads in a row, in the words a person would use. */
const CONFLICT_LABELS: Record<GitConflictKind, string> = {
  "both-modified": "Both modified",
  "both-added": "Both added",
  "both-deleted": "Both deleted",
  "added-by-us": "Added by us",
  "added-by-them": "Added by them",
  "deleted-by-us": "Deleted by us",
  "deleted-by-them": "Deleted by them",
};

export function conflictLabel(kind: GitConflictKind): string {
  return CONFLICT_LABELS[kind];
}

/**
 * The letter shown on a row.
 *
 * Untracked files report no status codes at all — porcelain gives them a `?`
 * record with nothing on either side — so `U` is chosen here rather than shown
 * as a blank badge. It reads as "untracked", and an untracked file can only
 * ever appear in the unstaged group, so it cannot be confused with `U` for
 * unmerged, which never reaches this function.
 */
function letterFor(change: GitFileChange, group: ScmGroupId): string {
  if (group === "merge") return "!";
  if (change.untracked) return "U";
  const code = group === "staged" ? change.indexStatus : change.worktreeStatus;
  return code ?? "M";
}

/**
 * Split a status into the panel's groups.
 *
 * A file appears in BOTH `staged` and `unstaged` when it has changes on each
 * side — the `MM` case — with each row carrying only its own side's line
 * counts. That is the whole reason the flat list had to go: one row could not
 * say "these two lines are going in the next commit and this third one is not".
 *
 * Conflicts are lifted into their own group ahead of the other two rather than
 * being sorted among them. A conflicted file is not staged or unstaged, and the
 * actions that make sense on it are entirely different — resolving it, not
 * staging it — so mixing it in would put buttons on a row that cannot honour
 * them.
 */
export function groupChanges(changes: readonly GitFileChange[]): readonly ScmGroup[] {
  const merge: ScmRow[] = [];
  const staged: ScmRow[] = [];
  const unstaged: ScmRow[] = [];

  for (const change of changes) {
    if (change.conflict !== undefined) {
      merge.push({
        change,
        group: "merge",
        letter: letterFor(change, "merge"),
        insertions: 0,
        deletions: 0,
        key: `merge:${change.path}`,
      });
      continue;
    }
    if (change.staged) {
      staged.push({
        change,
        group: "staged",
        letter: letterFor(change, "staged"),
        insertions: change.stagedInsertions,
        deletions: change.stagedDeletions,
        key: `staged:${change.path}`,
      });
    }
    if (change.unstaged) {
      unstaged.push({
        change,
        group: "unstaged",
        letter: letterFor(change, "unstaged"),
        insertions: change.unstagedInsertions,
        deletions: change.unstagedDeletions,
        key: `unstaged:${change.path}`,
      });
    }
  }

  const byPath = (left: ScmRow, right: ScmRow) => left.change.path.localeCompare(right.change.path);

  // Empty groups are dropped rather than shown as headers with nothing under
  // them; a repository with only unstaged work should read as one list.
  return [
    { id: "merge" as const, title: "Merge changes", rows: merge.toSorted(byPath) },
    { id: "staged" as const, title: "Staged changes", rows: staged.toSorted(byPath) },
    { id: "unstaged" as const, title: "Changes", rows: unstaged.toSorted(byPath) },
  ].filter((group) => group.rows.length > 0);
}

/**
 * Which paths a bulk action should be given, split by what git can do to them.
 *
 * Discarding is why this split exists: `git restore` needs an index entry to
 * restore from, and an untracked file has none, so those have to be deleted
 * instead. Handing every path to one command silently skips the untracked ones.
 */
export function partitionForDiscard(rows: readonly ScmRow[]): {
  tracked: string[];
  untracked: string[];
} {
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const row of rows) {
    if (row.change.untracked) untracked.push(row.change.path);
    else tracked.push(row.change.path);
  }
  return { tracked, untracked };
}

/**
 * Whether this shell can write to the index at all.
 *
 * The bridge methods are optional — a desktop build older than them simply has
 * no SCM panel — and a browser has no git. Checked once here so a missing
 * method is a hidden control rather than a `TypeError` inside a click handler.
 */
export function canWriteIndex(git: {
  stage?: unknown;
  unstage?: unknown;
  discard?: unknown;
} | null): boolean {
  return (
    git !== null &&
    typeof git.stage === "function" &&
    typeof git.unstage === "function" &&
    typeof git.discard === "function"
  );
}

/**
 * Whether a status can drive the panel.
 *
 * A workspace root reports no `changes`: staging is an operation on one index
 * and a folder of repositories has none. It gets a repository list instead,
 * each entry driving its own panel — the same reason `changes` is empty rather
 * than a merge of the children.
 */
export function hasIndexView(status: GitStatus | null | undefined): boolean {
  return status?.isRepo === true && status.isWorkspaceRoot !== true && status.changes !== undefined;
}
