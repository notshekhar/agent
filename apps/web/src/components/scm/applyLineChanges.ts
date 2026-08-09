/**
 * Building the file content that a partial stage should produce.
 *
 * Staging a hunk is usually done by synthesising a patch for the selected lines
 * and piping it to `git apply --cached`, which drags in every patch-generation
 * edge case there is: recomputing `@@` headers once lines are dropped,
 * preserving context, `\ No newline at end of file`, CRLF. None of that exists
 * here. This produces the whole file as it should look once the selection is
 * applied, and the shell writes that content straight into the index — the same
 * approach VS Code's git extension takes, for the same reason.
 *
 * Pure, and deliberately ignorant of git: it takes two versions of a file and a
 * set of line changes, and returns a third version. That makes the awkward
 * cases — an insertion at the very end, a deletion of the final line, an empty
 * file — assertable directly instead of through a repository.
 */

/**
 * One contiguous difference, in 1-based inclusive line numbers.
 *
 * The `0` conventions come from the shape VS Code uses and are worth stating
 * plainly, because they are what makes insertions and deletions expressible at
 * all:
 *
 *   - `originalEnd === 0` — a pure INSERTION. Nothing is removed; the new lines
 *     go in after `originalStart`.
 *   - `modifiedEnd === 0` — a pure DELETION. Nothing is added; the lines
 *     `originalStart..originalEnd` go away.
 *
 * Anything else replaces `originalStart..originalEnd` with
 * `modifiedStart..modifiedEnd`.
 */
export interface LineChange {
  readonly originalStart: number;
  readonly originalEnd: number;
  readonly modifiedStart: number;
  readonly modifiedEnd: number;
}

/**
 * Split into lines while keeping the trailing-newline distinction.
 *
 * `"a\nb\n"` becomes `["a", "b", ""]` and `"a\nb"` becomes `["a", "b"]`, so a
 * join round-trips exactly. That empty last element is what stops a file
 * without a trailing newline from silently gaining one — the case that most
 * often goes wrong, and which git records as `\ No newline at end of file`.
 */
function toLines(text: string): string[] {
  return text.split("\n");
}

/**
 * Apply `changes` to `original`, taking the new content from `modified`.
 *
 * Only the changes handed over are applied — that is the whole point. Passing
 * every change reproduces `modified`; passing one hunk stages only that hunk;
 * passing a subset of a hunk's lines stages only those. The caller decides what
 * is selected, and this does not care how.
 */
export function applyLineChanges(
  original: string,
  modified: string,
  changes: readonly LineChange[],
): string {
  const originalLines = toLines(original);
  const modifiedLines = toLines(modified);
  const result: string[] = [];

  // Ordered, because the walk is single-pass over `original` and a change out
  // of sequence would copy a region twice or skip one entirely.
  const ordered = changes.toSorted((left, right) => left.originalStart - right.originalStart);

  /** Next original line to copy, 0-based. */
  let cursor = 0;

  for (const change of ordered) {
    const isInsertion = change.originalEnd === 0;
    const isDeletion = change.modifiedEnd === 0;

    // Everything before the change, untouched. An insertion sits AFTER
    // `originalStart`, so that line is copied first; a replacement or deletion
    // begins AT `originalStart`, so it is not.
    const copyUntil = isInsertion ? change.originalStart : change.originalStart - 1;
    for (let line = cursor; line < copyUntil && line < originalLines.length; line++) {
      result.push(originalLines[line]!);
    }

    if (!isDeletion) {
      for (let line = change.modifiedStart - 1; line < change.modifiedEnd; line++) {
        const value = modifiedLines[line];
        if (value !== undefined) result.push(value);
      }
    }

    cursor = Math.max(cursor, isInsertion ? change.originalStart : change.originalEnd);
  }

  for (let line = cursor; line < originalLines.length; line++) {
    result.push(originalLines[line]!);
  }

  return result.join("\n");
}

/**
 * Turn a change round, so the same machinery can undo one.
 *
 * Unstaging a hunk is applying it backwards: the roles of the two files swap,
 * and an insertion becomes a deletion. Expressing it this way means there is
 * one implementation to get right rather than two that must agree.
 */
export function invertLineChange(change: LineChange): LineChange {
  return {
    originalStart: change.modifiedStart,
    originalEnd: change.modifiedEnd,
    modifiedStart: change.originalStart,
    modifiedEnd: change.originalEnd,
  };
}

/**
 * Narrow a change to the lines the user actually selected.
 *
 * Selecting part of a hunk is the difference between "stage this hunk" and
 * "stage these two lines of it". The selection is given in `modified` line
 * numbers, because that is what a person is looking at and clicking on.
 *
 * Returns null when the selection does not touch this change at all, so a
 * caller can filter without special-casing.
 *
 * A pure DELETION has no modified lines to intersect, so it is all-or-nothing:
 * either the selection reaches it or it does not.
 */
export function intersectChange(
  change: LineChange,
  selection: { readonly start: number; readonly end: number },
): LineChange | null {
  if (change.modifiedEnd === 0) {
    // Deletions attach to the boundary they sit on; a selection covering that
    // point takes the whole deletion with it.
    return selection.start <= change.modifiedStart && change.modifiedStart <= selection.end
      ? change
      : null;
  }

  const start = Math.max(change.modifiedStart, selection.start);
  const end = Math.min(change.modifiedEnd, selection.end);
  if (start > end) return null;

  // The whole change is inside the selection, so nothing needs narrowing.
  if (start === change.modifiedStart && end === change.modifiedEnd) return change;

  /**
   * A partially selected change becomes an INSERTION of the selected lines.
   *
   * The unselected lines of the original must survive — the user asked for
   * these lines and not the rest — so nothing is removed and the chosen lines
   * are added at the change's starting point. Treating it as a replacement
   * would quietly discard the original lines the selection did not cover.
   */
  return {
    originalStart: change.originalEnd === 0 ? change.originalStart : change.originalStart - 1,
    originalEnd: 0,
    modifiedStart: start,
    modifiedEnd: end,
  };
}
