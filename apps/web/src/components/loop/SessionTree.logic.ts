/**
 * Choosing what a session tree shows.
 *
 * The TUI's `/tree` has filter modes and a search box for a reason that shows
 * up immediately in real data: a 12-turn session is ~60 entries, most of them
 * tool calls and their results, and navigating is something you do BY the
 * prompts. An unfiltered list of every entry is technically complete and
 * practically unusable.
 *
 * The modes are a subset of the terminal's (`tree-list.ts` FILTER_MODES) —
 * `labeled-only` is left out because nothing in the app writes `/label` yet,
 * and a filter that always empties the list is a trap.
 *
 * Pure so the rules can be tested without a dialog.
 */
import type { SessionTreeRow } from "../../loop/tree";

export type TreeFilterMode = "default" | "prompts" | "no-tools" | "all";

export const TREE_FILTER_MODES: readonly {
  readonly id: TreeFilterMode;
  readonly label: string;
  readonly hint: string;
}[] = [
  { id: "default", label: "Default", hint: "Messages and the calls they made" },
  { id: "prompts", label: "Prompts", hint: "Only what you asked" },
  { id: "no-tools", label: "No tools", hint: "Messages only" },
  { id: "all", label: "All", hint: "Every entry, bookkeeping included" },
];

/** Entry types that are bookkeeping rather than conversation. */
const BOOKKEEPING: ReadonlySet<string> = new Set(["session-info", "label", "session-name"]);

function matchesMode(row: SessionTreeRow, mode: TreeFilterMode): boolean {
  if (mode === "all") return true;
  if (BOOKKEEPING.has(row.type)) return false;
  if (mode === "prompts") return row.role === "user";
  if (mode === "no-tools") return row.role !== "tool";
  return true;
}

/** Everything a row could reasonably be searched by, lowercased. */
export function treeRowSearchText(row: SessionTreeRow): string {
  const parts = [row.text ?? "", row.label ?? "", row.role ?? "", row.type];
  for (const tool of row.tools ?? []) {
    parts.push(tool.name);
    // The argument is what you actually remember — "the grep for login", not
    // "a grep". Stringified defensively; an unserializable input just adds
    // nothing rather than throwing mid-render.
    try {
      parts.push(typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input) ?? "");
    } catch {
      /* ignore */
    }
  }
  return parts.join(" ").toLowerCase();
}

export interface FilterTreeInput {
  readonly rows: readonly SessionTreeRow[];
  readonly mode: TreeFilterMode;
  readonly query: string;
  /** Never hidden, whatever the filter says — you must always be able to see
   * where the session currently is. */
  readonly leafId: string | null;
}

/**
 * The rows to draw, with indentation renormalised.
 *
 * Renormalising matters: hiding intermediate entries leaves the survivors
 * carrying indents computed against rows that are no longer there, so a
 * filtered list would show gaps like 0 → 3 and read as broken nesting. The
 * distinct indents present are mapped onto 0,1,2… which preserves the ordering
 * and the fact that a fork happened, without pretending to a depth the visible
 * rows do not show.
 */
export function filterTreeRows(input: FilterTreeInput): readonly SessionTreeRow[] {
  const query = input.query.trim().toLowerCase();
  const kept = input.rows.filter((row) => {
    if (row.id === input.leafId) return true;
    if (!matchesMode(row, input.mode)) return false;
    return query === "" || treeRowSearchText(row).includes(query);
  });

  const levels = [...new Set(kept.map((row) => row.indent))].sort((left, right) => left - right);
  const rank = new Map(levels.map((level, index) => [level, index]));
  return kept.map((row) =>
    rank.get(row.indent) === row.indent ? row : { ...row, indent: rank.get(row.indent) ?? 0 },
  );
}

/** `2 branches · 48 entries` — what the header says about the whole tree. */
export function treeSummary(rows: readonly SessionTreeRow[], branchPoints: number): string {
  const entries = rows.filter((row) => !BOOKKEEPING.has(row.type)).length;
  const parts = [`${entries} ${entries === 1 ? "entry" : "entries"}`];
  if (branchPoints > 0) {
    parts.unshift(`${branchPoints} ${branchPoints === 1 ? "branch point" : "branch points"}`);
  }
  return parts.join(" · ");
}
