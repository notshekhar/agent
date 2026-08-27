import type { LineChange } from "./applyLineChanges";

/**
 * Unified diff text, turned into the line changes a partial stage needs.
 *
 * The panel already has both patches — `--cached` for the index and a bare
 * `diff` for the working tree — so the hunk boundaries are sitting right there
 * and there is no reason to run a diff algorithm again to rediscover them.
 * Parsing them is also exactly reversible: a hunk parsed out of the unstaged
 * patch describes index → working tree, which is the pair `applyLineChanges`
 * wants for staging, and the staged patch describes HEAD → index, which is the
 * pair it wants for unstaging.
 *
 * Pure text in, plain objects out, so the fiddly parts — a hunk with no
 * newline at the end, a pure deletion, a rename header — are assertable without
 * a repository.
 */

export interface FileHunks {
  /** Path on the "after" side; a rename reports where it ended up. */
  readonly path: string;
  readonly hunks: readonly Hunk[];
}

export interface Hunk {
  /** The `@@` line, for a header the user can recognise. */
  readonly header: string;
  /** What this hunk does, in the shape `applyLineChanges` applies. */
  readonly change: LineChange;
  /** The hunk's own lines, for rendering it without re-parsing. */
  readonly lines: readonly HunkLine[];
}

export interface HunkLine {
  readonly kind: "context" | "added" | "removed";
  readonly text: string;
  /** 1-based line number on the "after" side; null for a removed line. */
  readonly modifiedLine: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Split a patch covering several files into per-file hunks.
 *
 * `diff --git` starts each file. The `+++ b/path` line is preferred for the
 * name because it survives a rename, and because git quotes and escapes paths
 * in the `diff --git` line when they contain unusual characters.
 */
export function parseUnifiedDiff(patch: string): FileHunks[] {
  const files: FileHunks[] = [];
  const lines = patch.split("\n");

  let path: string | null = null;
  let hunks: Hunk[] = [];
  let current: { header: string; lines: HunkLine[]; originalStart: number; modifiedStart: number } | null =
    null;

  const closeHunk = () => {
    if (current === null) return;
    hunks.push({
      header: current.header,
      change: toLineChange(current.originalStart, current.modifiedStart, current.lines),
      lines: current.lines,
    });
    current = null;
  };
  const closeFile = () => {
    closeHunk();
    if (path !== null && hunks.length > 0) files.push({ path, hunks });
    path = null;
    hunks = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      closeFile();
      continue;
    }
    if (line.startsWith("+++ ")) {
      // `+++ /dev/null` is a deletion; the name then has to come from `---`.
      const name = line.slice(4).trim();
      path = name === "/dev/null" ? path : stripPrefix(name);
      continue;
    }
    if (line.startsWith("--- ")) {
      const name = line.slice(4).trim();
      if (path === null && name !== "/dev/null") path = stripPrefix(name);
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      closeHunk();
      current = {
        header: line,
        lines: [],
        originalStart: Number.parseInt(header[1]!, 10),
        modifiedStart: Number.parseInt(header[3]!, 10),
      };
      continue;
    }

    if (current === null) continue;

    // "\ No newline at end of file" annotates the line before it and is not
    // itself content; carrying it into the hunk would stage a literal line.
    if (line.startsWith("\\")) continue;

    const marker = line[0];
    if (marker === "+") {
      current.lines.push({ kind: "added", text: line.slice(1), modifiedLine: null });
    } else if (marker === "-") {
      current.lines.push({ kind: "removed", text: line.slice(1), modifiedLine: null });
    } else if (marker === " " || line === "") {
      current.lines.push({ kind: "context", text: line.slice(1), modifiedLine: null });
    }
  }
  closeFile();

  return files.map((file) => ({ ...file, hunks: file.hunks.map(numberLines) }));
}

/** `a/src/x.ts` and `b/src/x.ts` both name `src/x.ts`. */
function stripPrefix(name: string): string {
  return name.replace(/^[ab]\//, "");
}

/**
 * The first and last line of a hunk's removed (or added) run. They are only
 * ever set together, so they travel as one value — that is what lets the
 * caller read `.last` off a non-null span without a non-null assertion.
 */
type LineSpan = { readonly first: number; readonly last: number };

function extendSpan(span: LineSpan | null, at: number): LineSpan {
  return span === null ? { first: at, last: at } : { first: span.first, last: at };
}

/**
 * The change a hunk represents, in `applyLineChanges` terms.
 *
 * A hunk's removed lines are contiguous within it, as are its added lines, but
 * the hunk also carries leading and trailing context that must not be part of
 * the change — including that context would rewrite lines the user did not
 * touch. So the range is narrowed to the first and last non-context line.
 *
 * A hunk with no added lines is a pure deletion, and one with no removed lines
 * is a pure insertion; both are signalled by the `0` end that
 * `applyLineChanges` expects.
 */
function toLineChange(
  originalStart: number,
  modifiedStart: number,
  lines: readonly HunkLine[],
): LineChange {
  let originalCursor = originalStart;
  let modifiedCursor = modifiedStart;
  let removed: LineSpan | null = null;
  let added: LineSpan | null = null;

  for (const line of lines) {
    if (line.kind === "context") {
      originalCursor += 1;
      modifiedCursor += 1;
      continue;
    }
    if (line.kind === "removed") {
      removed = extendSpan(removed, originalCursor);
      originalCursor += 1;
      continue;
    }
    added = extendSpan(added, modifiedCursor);
    modifiedCursor += 1;
  }

  return {
    // An insertion goes AFTER the line preceding it, which is where the added
    // lines begin on the original side minus one.
    originalStart:
      removed === null
        ? (added?.first ?? modifiedStart) - modifiedStart + originalStart - 1
        : removed.first,
    originalEnd: removed?.last ?? 0,
    modifiedStart:
      added === null
        ? (removed?.first ?? originalStart) - originalStart + modifiedStart
        : added.first,
    modifiedEnd: added?.last ?? 0,
  };
}

/** Fill in each added/context line's number on the "after" side, for the UI. */
function numberLines(hunk: Hunk): Hunk {
  const header = HUNK_HEADER.exec(hunk.header);
  let modifiedCursor = header ? Number.parseInt(header[3]!, 10) : 1;
  const lines = hunk.lines.map((line) => {
    if (line.kind === "removed") return line;
    const numbered = { ...line, modifiedLine: modifiedCursor };
    modifiedCursor += 1;
    return numbered;
  });
  return { ...hunk, lines };
}

/** Every hunk in the patch that belongs to one file. */
export function hunksForPath(patch: string, path: string): readonly Hunk[] {
  return parseUnifiedDiff(patch).find((file) => file.path === path)?.hunks ?? [];
}
