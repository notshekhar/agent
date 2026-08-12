/**
 * The verb-group vocabulary — how a run of tool rows becomes one honest line
 * of English: `Read 1 skill, Listed 2 dirs, Searched 1 pattern · 1 failed`.
 *
 * Ported from grok-build (`blocks/tool/mod.rs`), including the distinction
 * that makes the whole thing work: a tool is classified into a KIND, and kinds
 * split into two families.
 *
 * - **Folding kinds** (reads, listings, searches, fetches, subagents) collapse
 *   eagerly into a header. These are the calls whose individual detail is
 *   noise — you rarely need to know *which* four files were read, only that
 *   four were.
 * - **Label-only kinds** (commands, edits, MCP dispatches) never fold. For
 *   these the detail IS the information: which command ran, which file changed.
 *   They still own a bucket so a header that hides them can name them.
 *
 * ## Third-party tools
 *
 * The classification is deliberately NOT a switch over loop's builtin tool
 * names — extensions and MCP servers introduce tools this file has never heard
 * of, and they must degrade well rather than break grouping or vanish into an
 * anonymous "3 tools". Three layers, most specific first:
 *
 * 1. An explicit registration ({@link registerToolVerbGroup}) — a tool that
 *    knows what it does can say so, and gets first-class grouping.
 * 2. A NAME heuristic. Third-party tools are overwhelmingly `verb_noun`
 *    (`search_issues`, `list_repos`, `fetch_page`), so a leading verb the
 *    vocabulary already knows classifies the tool. Deliberately conservative:
 *    it fires only on an unambiguous leading verb, because a wrong guess here
 *    hides a row under a label that misdescribes it.
 * 3. Otherwise `other` — which does NOT fold. An unknown tool keeps its own
 *    visible row, because we cannot know whether its detail matters. Staying
 *    visible is the safe failure: the worst case is a transcript slightly
 *    longer than it could be, rather than information silently hidden.
 */

/** A kind's grammar: tense-aware verb plus a singular/plural noun. */
export interface VerbGroupKind {
    /** Shown once the calls have finished ("Read"). */
    past: string;
    /** Shown while any member is still running ("Reading"). */
    present: string;
    nounOne: string;
    nounMany: string;
    /**
     * Whether a run of these collapses into a header on its own. False keeps
     * the rows visible; the kind is still used to NAME them inside a header
     * that hides them for another reason.
     */
    folds: boolean;
}

const KIND = {
    file: { past: "Read", present: "Reading", nounOne: "file", nounMany: "files", folds: true },
    skill: { past: "Read", present: "Reading", nounOne: "skill", nounMany: "skills", folds: true },
    dir: { past: "Listed", present: "Listing", nounOne: "dir", nounMany: "dirs", folds: true },
    search: { past: "Searched", present: "Searching", nounOne: "pattern", nounMany: "patterns", folds: true },
    web: { past: "Fetched", present: "Fetching", nounOne: "website", nounMany: "websites", folds: true },
    memory: { past: "Searched", present: "Searching", nounOne: "memory", nounMany: "memories", folds: true },
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
 * ones: `get_*` is absent on purpose (it is as often a mutation-adjacent RPC
 * as a read), and so is `run_*` (which says nothing about what ran).
 */
const NAME_VERBS: Array<[RegExp, VerbGroupKindId]> = [
    [/^(read|cat|open)(_|$)/, "file"],
    [/^(ls|list|dir)(_|$)/, "dir"],
    [/^(search|grep|find|query|lookup)(_|$)/, "search"],
    [/^(fetch|crawl|scrape|browse)(_|$)/, "web"],
    [/^(edit|write|patch|update|create|delete)(_|$)/, "edit"],
];

/** Explicit registrations — extensions naming their own tools' grammar. */
const registered = new Map<string, VerbGroupKindId>();

/**
 * Declare how a tool should be grouped and named. Intended for extensions:
 * `registerToolVerbGroup("fetch_issues", "web")`. Overrides both the builtin
 * table and the name heuristic, so a tool whose name lies about what it does
 * can still be described correctly.
 */
export function registerToolVerbGroup(toolName: string, kind: VerbGroupKindId): void {
    registered.set(toolName, kind);
}

/** Drop all registrations (extension reload, tests). */
export function clearToolVerbGroups(): void {
    registered.clear();
}

/** The kind id for a tool name — see the layering note at the top of the file. */
export function kindIdOf(toolName: string): VerbGroupKindId {
    const explicit = registered.get(toolName);
    if (explicit) return explicit;
    const builtin = BUILTIN[toolName];
    if (builtin) return builtin;
    // MCP tools arrive namespaced (`server__tool`); classify on the tool part,
    // and fall back to the MCP bucket rather than the anonymous one so at
    // least the header says where the call went.
    const bare = toolName.includes("__") ? toolName.slice(toolName.lastIndexOf("__") + 2) : toolName;
    const lower = bare.toLowerCase();
    for (const [re, kind] of NAME_VERBS) if (re.test(lower)) return kind;
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
    toolName: string;
    isError: boolean;
    isRunning: boolean;
}

/**
 * The aggregated header text for a run: one segment per kind in first-seen
 * order, joined with ", ", plus a failure suffix when any member failed.
 *
 * Kinds are bucketed rather than tools, so `read` + `skill` read as
 * "Read 2 files, Read 1 skill" — two honest segments — while `grep` + `glob`
 * merge into one "Searched 2 patterns". Tense follows the run: any member
 * still running makes the whole label present-tense, because the run as a
 * whole is still happening.
 */
export function verbGroupLabel(members: GroupMember[]): { text: string; failed: number } {
    const running = members.some((m) => m.isRunning);
    const order: VerbGroupKindId[] = [];
    const counts = new Map<VerbGroupKindId, number>();
    let failed = 0;
    for (const m of members) {
        const id = kindIdOf(m.toolName);
        if (!counts.has(id)) order.push(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (m.isError) failed++;
    }
    const text = order
        .map((id) => {
            const kind = KIND[id];
            const n = counts.get(id)!;
            return `${running ? kind.present : kind.past} ${n} ${n === 1 ? kind.nounOne : kind.nounMany}`;
        })
        .join(", ");
    return { text, failed };
}
