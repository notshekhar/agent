/**
 * Runs of finished tool calls, as one line of English.
 *
 * This is a port of `packages/cli/src/interactive/ui/verb-group.ts`, which is
 * what the terminal's live mode folds a transcript with: a tool is classified
 * into a KIND, kinds carry a tense-aware verb and a noun, and a run of adjacent
 * calls becomes `Read 2 files, Listed 1 dir`. The web is a second surface for
 * the same transcript and has to agree with the terminal about what a run is
 * called, so the vocabulary is reproduced here rather than reinvented.
 *
 * Ported rather than imported for the same reason as `loopToolSummary.ts`: the
 * CLI module lives in a tree that reaches for the extension host and the ANSI
 * theme. Only the grammar comes across.
 *
 * KEEP IN SYNC with the CLI module. If loop grows a tool, both need the case.
 *
 * The one thing NOT ported is the CLI's `registerToolVerbGroup` seam, which
 * exists for extensions — CLI-side code that cannot run in a browser. A tool
 * registered there classifies by the name heuristic here instead, which is the
 * same answer for anything named `verb_noun` and a visible row otherwise.
 */

/** A kind's grammar: tense-aware verb plus a singular/plural noun. */
export interface VerbGroupKind {
  /** Shown once the calls have finished ("Read"). */
  readonly past: string;
  /** Shown while any member is still running ("Reading"). */
  readonly present: string;
  readonly nounOne: string;
  readonly nounMany: string;
  /**
   * Whether a run of these collapses into a header on its own. False keeps the
   * rows visible; the kind is still used to NAME them inside a header that
   * hides them for another reason.
   */
  readonly folds: boolean;
}

const KIND = {
  file: { past: "Read", present: "Reading", nounOne: "file", nounMany: "files", folds: true },
  skill: { past: "Read", present: "Reading", nounOne: "skill", nounMany: "skills", folds: true },
  dir: { past: "Listed", present: "Listing", nounOne: "dir", nounMany: "dirs", folds: true },
  search: {
    past: "Searched",
    present: "Searching",
    nounOne: "pattern",
    nounMany: "patterns",
    folds: true,
  },
  web: { past: "Fetched", present: "Fetching", nounOne: "website", nounMany: "websites", folds: true },
  memory: {
    past: "Searched",
    present: "Searching",
    nounOne: "memory",
    nounMany: "memories",
    folds: true,
  },
  subagent: { past: "Ran", present: "Running", nounOne: "subagent", nounMany: "subagents", folds: true },
  todo: { past: "Updated", present: "Updating", nounOne: "todo list", nounMany: "todo lists", folds: true },

  // Label-only: the detail is the point, so these keep their own rows.
  command: { past: "Ran", present: "Running", nounOne: "command", nounMany: "commands", folds: false },
  edit: { past: "Edited", present: "Editing", nounOne: "file", nounMany: "files", folds: false },
  mcp: { past: "Called", present: "Calling", nounOne: "MCP tool", nounMany: "MCP tools", folds: false },
  other: { past: "Ran", present: "Running", nounOne: "tool", nounMany: "tools", folds: false },
} as const satisfies Record<string, VerbGroupKind>;

export type VerbGroupKindId = keyof typeof KIND;

/** loop's builtin tools. Anything absent falls through to the heuristic. */
const BUILTIN: Record<string, VerbGroupKindId> = {
  read: "file",
  skill: "skill",
  ls: "dir",
  tree: "dir",
  glob: "search",
  grep: "search",
  find: "search",
  websearch: "search",
  webfetch: "web",
  memory: "memory",
  task: "subagent",
  todo: "todo",
  bash: "command",
  edit: "edit",
  write: "edit",
};

/**
 * Leading verbs that classify an unregistered tool by name. Only unambiguous
 * ones: `get_*` is absent on purpose (it is as often a mutation-adjacent RPC as
 * a read), and so is `run_*` (which says nothing about what ran).
 */
const NAME_VERBS: ReadonlyArray<readonly [RegExp, VerbGroupKindId]> = [
  [/^(read|cat|open)(_|$)/, "file"],
  [/^(ls|list|dir)(_|$)/, "dir"],
  [/^(search|grep|find|query|lookup)(_|$)/, "search"],
  [/^(fetch|crawl|scrape|browse)(_|$)/, "web"],
  [/^(edit|write|patch|update|create|delete)(_|$)/, "edit"],
];

/** The kind id for a tool name — see the layering note at the top of the file. */
export function kindIdOf(toolName: string): VerbGroupKindId {
  const builtin = BUILTIN[toolName];
  if (builtin) return builtin;
  // MCP tools arrive namespaced (`server__tool`); classify on the tool part,
  // and fall back to the MCP bucket rather than the anonymous one so at least
  // the header says where the call went.
  const bare = toolName.includes("__")
    ? toolName.slice(toolName.lastIndexOf("__") + 2)
    : toolName;
  const lower = bare.toLowerCase();
  for (const [pattern, kind] of NAME_VERBS) if (pattern.test(lower)) return kind;
  return toolName.includes("__") ? "mcp" : "other";
}

export function kindOf(toolName: string): VerbGroupKind {
  return KIND[kindIdOf(toolName)];
}

/** Whether a run of this tool collapses into a group header on its own. */
export function foldsEagerly(toolName: string): boolean {
  return kindOf(toolName).folds;
}

export interface GroupMember {
  readonly toolName: string;
  readonly isError: boolean;
  readonly isRunning: boolean;
}

/**
 * The aggregated header text for a run: one segment per kind in first-seen
 * order, joined with ", ", plus the count of members that failed.
 *
 * Kinds are bucketed rather than tools, so `read` + `skill` read as "Read 2
 * files, Read 1 skill" — two honest segments — while `grep` + `glob` merge into
 * one "Searched 2 patterns".
 */
export function verbGroupLabel(members: readonly GroupMember[]): {
  text: string;
  failed: number;
} {
  const running = members.some((member) => member.isRunning);
  const order: VerbGroupKindId[] = [];
  const counts = new Map<VerbGroupKindId, number>();
  let failed = 0;
  for (const member of members) {
    const id = kindIdOf(member.toolName);
    if (!counts.has(id)) order.push(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (member.isError) failed++;
  }
  const text = order
    .map((id) => {
      const kind = KIND[id];
      const n = counts.get(id) ?? 0;
      return `${running ? kind.present : kind.past} ${n} ${n === 1 ? kind.nounOne : kind.nounMany}`;
    })
    .join(", ");
  return { text, failed };
}

/** The shape of a tool call this module needs to place it in a run. */
export interface GroupableTool {
  readonly name: string;
  readonly isError: boolean;
  readonly isPartial: boolean;
}

/**
 * Whether a row may be swallowed into a group.
 *
 * A RUNNING call never groups: it is the one row worth watching mid-turn, and
 * "Reading 3 files" would not say which. It joins the header once it lands.
 * `plan` never joins either — it is an approval surface that must stay
 * readable, and the timeline routes it to its own card anyway.
 *
 * The last gate is the KIND: only kinds whose individual detail is noise fold.
 * A command or an edit keeps its row because which command ran is the whole
 * point, and so does any tool the vocabulary cannot classify — staying visible
 * is the safe failure for a third-party tool.
 */
export function isGroupableTool(tool: GroupableTool): boolean {
  return !tool.isPartial && tool.name !== "plan" && foldsEagerly(tool.name);
}

export type ToolRun<T> =
  | { readonly kind: "single"; readonly item: T }
  | {
      readonly kind: "group";
      readonly items: readonly T[];
      readonly label: string;
      readonly failed: number;
    };

/**
 * Fold a list of work-log items into runs, in order.
 *
 * One member is enough to fold, as in the terminal (grok's `RunScan::folds`):
 * "Read 1 file" is already tighter than the row it replaces, and folding from
 * the first call means a second one joins an existing header instead of the
 * row visibly collapsing under the reader.
 *
 * `toolOf` returns null for an item that is not a loop tool call (an approval,
 * a hook line, a compaction) — those break a run, because a header that
 * swallowed them would be describing calls that are not there.
 */
export function groupToolRuns<T>(
  items: readonly T[],
  toolOf: (item: T) => GroupableTool | null,
): Array<ToolRun<T>> {
  const runs: Array<ToolRun<T>> = [];
  let open: T[] = [];
  let members: GroupMember[] = [];

  const close = (): void => {
    if (open.length === 0) return;
    const { text, failed } = verbGroupLabel(members);
    runs.push({ kind: "group", items: open, label: text, failed });
    open = [];
    members = [];
  };

  for (const item of items) {
    const tool = toolOf(item);
    if (tool && isGroupableTool(tool)) {
      open.push(item);
      members.push({ toolName: tool.name, isError: tool.isError, isRunning: tool.isPartial });
      continue;
    }
    close();
    runs.push({ kind: "single", item });
  }
  close();
  return runs;
}
