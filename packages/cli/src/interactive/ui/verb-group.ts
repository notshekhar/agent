/**
 * The verb-group vocabulary — how a run of tool rows becomes one honest line
 * of English: `Read 1 skill, Listed 2 dirs, Searched 1 pattern · 1 failed`.
 *
 * Ported from grok-build (`blocks/tool/mod.rs`), including the distinction
 * that makes the whole thing work: a tool is classified into a KIND, and the
 * kind decides both the grammar and whether a run of them folds into a header.
 *
 * Nearly everything folds — reads, listings, searches, fetches, subagents,
 * commands, and third-party calls — because a run's individual detail is noise
 * you can open the group to get back. `edit` is the one exception: which file
 * changed is the thing you are watching for, and it is what you review.
 *
 * ## Tools we did not write
 *
 * Extensions and MCP servers introduce tools this file has never heard of, and
 * the classification must handle them by RULE rather than by guesswork. Three
 * layers, most specific first:
 *
 * 1. An explicit registration ({@link registerToolVerbGroup}) — a tool that
 *    knows what it does says so, and gets first-class grammar. This is the
 *    supported way for an extension to read as well as a builtin.
 * 2. {@link BUILTIN} — loop's own tools, named exactly.
 * 3. Otherwise it is somebody else's tool, and we say only what we actually
 *    know: whether it came over MCP (namespaced `server__tool`) or from an
 *    extension. Both fold.
 *
 * There used to be a fourth layer between 2 and 3: a heuristic that read a
 * leading verb off the name (`list_*` → dir, `search_*` → search). It was
 * removed because it produced both of the failures grouping is supposed to
 * avoid. Folding became a lottery on how a server had spelled things —
 * `sentry__list_errors` folded, `sentry__get_error` did not, from one server in
 * one run — and when it did fire it borrowed the BUILTIN's NOUN along with the
 * verb, so a run of Sentry lookups rendered as "Listed 2 dirs". A verb travels
 * to a third-party tool; the noun it was paired with does not. Saying "Called 2
 * MCP tools" knows less and claims exactly that much.
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
    data: { past: "Queried", present: "Querying", nounOne: "datasource", nounMany: "datasources", folds: true },
    artifact: { past: "Created", present: "Creating", nounOne: "artifact", nounMany: "artifacts", folds: true },

    command: { past: "Ran", present: "Running", nounOne: "command", nounMany: "commands", folds: true },

    // Tools we did not write, named by the only thing we reliably know about
    // them — where they came from. Both fold; see the layering note above.
    mcp: { past: "Called", present: "Calling", nounOne: "MCP tool", nounMany: "MCP tools", folds: true },
    extension: {
        past: "Called",
        present: "Calling",
        nounOne: "extension tool",
        nounMany: "extension tools",
        folds: true,
    },

    // Kinds that keep their rows. `edit` because which file changed is the
    // information and it is what gets reviewed; `ask` and `plan` because they
    // are surfaces the user acts on, and a surface folded into a count is one
    // nobody answers.
    edit: { past: "Edited", present: "Editing", nounOne: "file", nounMany: "files", folds: false },
    ask: { past: "Asked", present: "Asking", nounOne: "question", nounMany: "questions", folds: false },
    plan: { past: "Planned", present: "Planning", nounOne: "plan", nounMany: "plans", folds: false },
} as const satisfies Record<string, VerbGroupKind>;

export type VerbGroupKindId = keyof typeof KIND;

/** loop's builtin tools. Anything absent is somebody else's tool. */
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
    sql: "data",
    artifact: "artifact",
    ask: "ask",
    plan: "plan",
    enter_plan_mode: "plan",
};

/** Explicit registrations — extensions naming their own tools' grammar. */
const registered = new Map<string, VerbGroupKindId>();

/**
 * Declare how a tool should be grouped and named:
 * `registerToolVerbGroup("fetch_issues", "web")`.
 *
 * This is the ONLY way a third-party tool gets a builtin's grammar, and it
 * beats every rule below it — deliberately, because a name is not evidence.
 * Without a registration a tool is described by where it came from, which is
 * the most we actually know about it.
 */
export function registerToolVerbGroup(toolName: string, kind: VerbGroupKindId): void {
    registered.set(toolName, kind);
}

/** Drop all registrations (extension reload, tests). */
export function clearToolVerbGroups(): void {
    registered.clear();
}

/** MCP tools arrive namespaced as `server__tool`. */
function isMcpToolName(toolName: string): boolean {
    return toolName.includes("__");
}

/** The kind id for a tool name — see the layering note at the top of the file. */
export function kindIdOf(toolName: string): VerbGroupKindId {
    const explicit = registered.get(toolName);
    if (explicit) return explicit;
    const builtin = BUILTIN[toolName];
    if (builtin) return builtin;
    // Not ours and not registered: say where it came from and nothing more.
    return isMcpToolName(toolName) ? "mcp" : "extension";
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
