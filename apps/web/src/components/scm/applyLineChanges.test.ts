import { describe, expect, it } from "vite-plus/test";

import {
  type LineChange,
  applyLineChanges,
  intersectChange,
  invertLineChange,
} from "./applyLineChanges";

/**
 * These are the calculations that decide what ends up in someone's index, so
 * the assertions are on exact strings — including trailing newlines, which is
 * where partial staging most often goes wrong.
 */

const modify = (
  originalStart: number,
  originalEnd: number,
  modifiedStart: number,
  modifiedEnd: number,
): LineChange => ({ originalStart, originalEnd, modifiedStart, modifiedEnd });

const insertAfter = (originalLine: number, modifiedStart: number, modifiedEnd: number): LineChange =>
  ({ originalStart: originalLine, originalEnd: 0, modifiedStart, modifiedEnd });

const deleteLines = (originalStart: number, originalEnd: number, at: number): LineChange => ({
  originalStart,
  originalEnd,
  modifiedStart: at,
  modifiedEnd: 0,
});

describe("applying no changes", () => {
  it("returns the original untouched", () => {
    // Staging nothing must not rewrite the file — including its trailing newline.
    expect(applyLineChanges("a\nb\n", "a\nB\n", [])).toBe("a\nb\n");
  });
});

describe("applying every change", () => {
  it("reproduces the modified file exactly", () => {
    // The property that matters: "stage all hunks" and "stage the file" agree.
    const original = "one\ntwo\nthree\n";
    const modified = "one\nTWO\nthree\n";
    expect(applyLineChanges(original, modified, [modify(2, 2, 2, 2)])).toBe(modified);
  });

  it("reproduces a file with several separated changes", () => {
    const original = "a\nb\nc\nd\ne\n";
    const modified = "A\nb\nc\nD\ne\n";
    const changes = [modify(1, 1, 1, 1), modify(4, 4, 4, 4)];
    expect(applyLineChanges(original, modified, changes)).toBe(modified);
  });
});

describe("staging only part of the work", () => {
  it("takes one hunk and leaves the other alone", () => {
    // The whole point of hunk staging: the index gets content that exists in
    // neither HEAD nor the working tree.
    const original = "a\nb\nc\nd\ne\n";
    const modified = "A\nb\nc\nD\ne\n";
    expect(applyLineChanges(original, modified, [modify(1, 1, 1, 1)])).toBe("A\nb\nc\nd\ne\n");
    expect(applyLineChanges(original, modified, [modify(4, 4, 4, 4)])).toBe("a\nb\nc\nD\ne\n");
  });
});

describe("insertions", () => {
  it("inserts after the named line", () => {
    const original = "a\nc\n";
    const modified = "a\nb\nc\n";
    expect(applyLineChanges(original, modified, [insertAfter(1, 2, 2)])).toBe("a\nb\nc\n");
  });

  it("inserts at the very start", () => {
    const original = "b\n";
    const modified = "a\nb\n";
    expect(applyLineChanges(original, modified, [insertAfter(0, 1, 1)])).toBe("a\nb\n");
  });

  it("inserts at the very end without disturbing the trailing newline", () => {
    // An append is where an off-by-one shows up as a lost or doubled newline.
    const original = "a\n";
    const modified = "a\nb\n";
    expect(applyLineChanges(original, modified, [insertAfter(1, 2, 2)])).toBe("a\nb\n");
  });

  it("appends to a file that has no trailing newline", () => {
    const original = "a";
    const modified = "a\nb";
    expect(applyLineChanges(original, modified, [insertAfter(1, 2, 2)])).toBe("a\nb");
  });
});

describe("deletions", () => {
  it("removes the named lines", () => {
    const original = "a\nb\nc\n";
    const modified = "a\nc\n";
    expect(applyLineChanges(original, modified, [deleteLines(2, 2, 1)])).toBe("a\nc\n");
  });

  it("removes the final line without leaving a stray blank", () => {
    const original = "a\nb\n";
    const modified = "a\n";
    expect(applyLineChanges(original, modified, [deleteLines(2, 2, 1)])).toBe("a\n");
  });

  it("removes every line", () => {
    const original = "a\nb\n";
    const modified = "";
    expect(applyLineChanges(original, modified, [deleteLines(1, 2, 0)])).toBe("");
  });
});

describe("line endings and edges", () => {
  it("leaves CRLF endings intact", () => {
    // The lines carry their own \r; nothing here normalises, and the shell's
    // `hash-object --path` applies whatever the repo's filters say.
    const original = "a\r\nb\r\n";
    const modified = "a\r\nB\r\n";
    expect(applyLineChanges(original, modified, [modify(2, 2, 2, 2)])).toBe("a\r\nB\r\n");
  });

  it("does not add a trailing newline to a file that never had one", () => {
    const original = "a\nb";
    const modified = "a\nB";
    expect(applyLineChanges(original, modified, [modify(2, 2, 2, 2)])).toBe("a\nB");
  });

  it("stages content into an empty file", () => {
    // An empty file is one empty line, and `"hello\n"` is `["hello", ""]` — so
    // the inserted range is line 1 alone. Claiming lines 1..2 would insert the
    // trailing empty line as well and the file would gain a blank line.
    expect(applyLineChanges("", "hello\n", [insertAfter(0, 1, 1)])).toBe("hello\n");
  });

  it("applies changes given out of order", () => {
    // A selection built from clicks arrives in whatever order they happened.
    const original = "a\nb\nc\nd\n";
    const modified = "A\nb\nc\nD\n";
    const outOfOrder = [modify(4, 4, 4, 4), modify(1, 1, 1, 1)];
    expect(applyLineChanges(original, modified, outOfOrder)).toBe(modified);
  });
});

describe("inverting a change", () => {
  it("swaps the two sides, so unstaging is the same machinery backwards", () => {
    const staged = modify(2, 2, 2, 2);
    const inverted = invertLineChange(staged);
    // Applying the inverse to the modified file recovers the original.
    expect(applyLineChanges("a\nB\n", "a\nb\n", [inverted])).toBe("a\nb\n");
  });

  it("turns an insertion into a deletion", () => {
    const inserted = insertAfter(1, 2, 2);
    const inverted = invertLineChange(inserted);
    expect(inverted.modifiedEnd).toBe(0);
    expect(applyLineChanges("a\nb\n", "a\n", [inverted])).toBe("a\n");
  });
});

describe("narrowing a change to a selection", () => {
  it("keeps a change the selection covers entirely", () => {
    const change = modify(1, 3, 1, 3);
    expect(intersectChange(change, { start: 1, end: 3 })).toBe(change);
  });

  it("drops a change the selection does not reach", () => {
    expect(intersectChange(modify(1, 1, 1, 1), { start: 5, end: 9 })).toBeNull();
  });

  it("keeps the unselected original lines when only part is chosen", () => {
    // Selecting two lines of a three-line replacement must not silently discard
    // the original line the user did not select.
    const original = "x\ny\nz\n";
    const modified = "X\nY\nZ\n";
    const change = modify(1, 3, 1, 3);
    const narrowed = intersectChange(change, { start: 1, end: 2 });
    expect(narrowed).not.toBeNull();
    const staged = applyLineChanges(original, modified, [narrowed!]);
    // The two chosen lines are added; nothing from the original is lost.
    expect(staged).toBe("X\nY\nx\ny\nz\n");
  });

  it("takes a deletion whole or not at all", () => {
    // A deletion has no modified lines to slice.
    const change = deleteLines(2, 4, 1);
    expect(intersectChange(change, { start: 1, end: 1 })).toBe(change);
    expect(intersectChange(change, { start: 7, end: 9 })).toBeNull();
  });
});
