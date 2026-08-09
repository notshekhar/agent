import { describe, expect, it } from "vite-plus/test";

import { applyLineChanges } from "./applyLineChanges";
import { hunksForPath, parseUnifiedDiff } from "./parseHunks";

/**
 * The round trip is the assertion that matters: parse a real patch, apply every
 * hunk it produced to the original, and the modified file must come back
 * exactly. If the ranges are off by one the result is a corrupted file, and
 * that is what would land in someone's index.
 */

const patch = (body: string) => body.replaceAll("\t", "");

describe("parsing a modification", () => {
  it("narrows the change to the lines that actually differ", () => {
    // The hunk carries three lines of context on each side; including them
    // would rewrite lines the user never touched.
    const files = parseUnifiedDiff(
      patch(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,5 +1,5 @@
 one
 two
-three
+THREE
 four
 five
`),
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("x.ts");
    expect(files[0]?.hunks[0]?.change).toEqual({
      originalStart: 3,
      originalEnd: 3,
      modifiedStart: 3,
      modifiedEnd: 3,
    });
  });

  it("round-trips: applying the parsed hunk reproduces the modified file", () => {
    const original = "one\ntwo\nthree\nfour\nfive\n";
    const modified = "one\ntwo\nTHREE\nfour\nfive\n";
    const hunks = hunksForPath(
      patch(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,5 +1,5 @@
 one
 two
-three
+THREE
 four
 five
`),
      "x.ts",
    );
    expect(applyLineChanges(original, modified, hunks.map((hunk) => hunk.change))).toBe(modified);
  });
});

describe("parsing an insertion", () => {
  it("reports no original range and round-trips", () => {
    const original = "one\ntwo\n";
    const modified = "one\nNEW\ntwo\n";
    const hunks = hunksForPath(
      patch(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,3 @@
 one
+NEW
 two
`),
      "x.ts",
    );
    expect(hunks[0]?.change.originalEnd).toBe(0);
    expect(applyLineChanges(original, modified, hunks.map((h) => h.change))).toBe(modified);
  });
});

describe("parsing a deletion", () => {
  it("reports no modified range and round-trips", () => {
    const original = "one\ngone\ntwo\n";
    const modified = "one\ntwo\n";
    const hunks = hunksForPath(
      patch(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,2 @@
 one
-gone
 two
`),
      "x.ts",
    );
    expect(hunks[0]?.change.modifiedEnd).toBe(0);
    expect(applyLineChanges(original, modified, hunks.map((h) => h.change))).toBe(modified);
  });
});

describe("several hunks in one file", () => {
  it("round-trips all of them, and each one alone stages only itself", () => {
    const original = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n";
    const modified = "A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\n";
    const hunks = hunksForPath(
      patch(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,4 +1,4 @@
-a
+A
 b
 c
 d
@@ -9,4 +9,4 @@
 i
 j
 k
-l
+L
`),
      "x.ts",
    );
    expect(hunks).toHaveLength(2);
    expect(applyLineChanges(original, modified, hunks.map((h) => h.change))).toBe(modified);
    // The point of hunk staging: one without the other.
    expect(applyLineChanges(original, modified, [hunks[0]!.change])).toBe(
      "A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n",
    );
    expect(applyLineChanges(original, modified, [hunks[1]!.change])).toBe(
      "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\n",
    );
  });
});

describe("several files in one patch", () => {
  it("keeps each file's hunks separate", () => {
    const files = parseUnifiedDiff(
      patch(`diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-x
+X
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-y
+Y
`),
    );
    expect(files.map((file) => file.path)).toEqual(["one.ts", "two.ts"]);
    expect(files[0]?.hunks).toHaveLength(1);
    expect(files[1]?.hunks).toHaveLength(1);
  });
});

describe("awkward patches", () => {
  it("ignores the no-newline marker rather than staging it as a line", () => {
    const original = "one\ntwo";
    const modified = "one\nTWO";
    const hunks = hunksForPath(
      patch(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
 one
-two
\\ No newline at end of file
+TWO
\\ No newline at end of file
`),
      "x.ts",
    );
    expect(hunks[0]?.lines.some((line) => line.text.startsWith("No newline"))).toBe(false);
    expect(applyLineChanges(original, modified, hunks.map((h) => h.change))).toBe(modified);
  });

  it("names a new file from its +++ side", () => {
    const files = parseUnifiedDiff(
      patch(`diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+hello
+world
`),
    );
    expect(files[0]?.path).toBe("new.ts");
    expect(files[0]?.hunks[0]?.change.originalEnd).toBe(0);
  });

  it("returns nothing for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(hunksForPath("", "x.ts")).toEqual([]);
  });

  it("numbers the after-side lines so the UI can offer line selection", () => {
    const hunks = hunksForPath(
      patch(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,3 +10,4 @@
 keep
+added
 also
 last
`),
      "x.ts",
    );
    const added = hunks[0]?.lines.find((line) => line.kind === "added");
    expect(added?.modifiedLine).toBe(11);
    // Removed lines have no line on the after side.
    expect(hunks[0]?.lines.every((l) => (l.kind === "removed") === (l.modifiedLine === null))).toBe(
      true,
    );
  });
});
