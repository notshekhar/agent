/**
 * A session's entry tree, flattened for a client.
 *
 * A loop session is an append-only TREE, not a list: `/tree` moves the leaf to
 * an earlier entry and everything after it becomes an abandoned branch that no
 * longer reaches the model. That structure was invisible to every client but
 * the TUI, because `session.history` deliberately returns only the current
 * branch — which is the right answer for rendering a conversation and the
 * wrong one for choosing between them.
 *
 * So this walks all branches once and returns them pre-order (parents before
 * children, siblings oldest-first), which is exactly the order a tree list
 * draws. Presentation stays out: rows carry the message text and the tool
 * calls an entry made, and each surface applies its own grammar — the TUI's
 * `tool-summary.ts` and the web's port of it already disagree about styling
 * and must not start disagreeing about facts.
 */
import { stripSessionHookContext } from "./hook-context";
import type { Session, SessionTreeNode } from "./session";

/** Message text is a preview here, not the payload; the transcript has it whole. */
const MAX_TEXT_LEN = 200;

/** A tool call an entry carried, for the row's one-line summary. */
export interface TreeNodeTool {
    name: string;
    input: unknown;
}

export interface SessionTreeRow {
    id: string;
    parentId: string | null;
    ts: number;
    /** Entry type: `message`, `compact`, `session-info`, `branch-summary`, … */
    type: string;
    role?: "user" | "assistant" | "tool";
    /** Message text, hook context stripped and capped. Absent when there is none. */
    text?: string;
    /** True when `text` was cut, so a client can say so rather than implying
     * the message really ended there. */
    truncated?: boolean;
    /** Tool calls this entry made. A `tool` role entry carries results, which
     * only reference a `toolCallId` — those are resolved back to the call that
     * made them here, so a result row can name what it was the result OF. */
    tools?: TreeNodeTool[];
    /** `/label` text for this entry, if any. */
    label?: string;
    /**
     * How far to indent — NOT the depth in the tree.
     *
     * A conversation is a chain with occasional detours, so indenting once per
     * ancestor turns an ordinary session into a diagonal staircase and buys
     * nothing: every step of a single-child run is at the same "place". This
     * only moves right where the shape actually forks. See `childIndent`.
     */
    indent: number;
    /** Raw depth in the tree, for anything that needs the real structure. */
    depth: number;
    /** This row is one of several siblings — where a connector is drawn. */
    branchStart?: boolean;
    /** ...and the last of them, so the connector can close the group. */
    lastSibling?: boolean;
    /** On the branch the session is currently on — i.e. what the model sees. */
    onPath: boolean;
    /** Children in the tree. More than one is a branch point, which is the
     * only place navigating is a choice rather than a jump. */
    childCount: number;
    /** The turn that produced it was interrupted. */
    interrupted?: boolean;
}

export interface SessionTreeView {
    /** Where the session currently is; null for an empty session. */
    leafId: string | null;
    rows: SessionTreeRow[];
    /** Entries with more than one child — the points worth navigating to. */
    branchPointIds: string[];
}

interface ContentBlock {
    type?: string;
    text?: string;
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
}

function blocksOf(content: unknown): ContentBlock[] {
    return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    return blocksOf(content)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
}

/**
 * Index every `tool-call` in the tree by its id.
 *
 * Built over ALL branches, not the current path: the whole point of the tree
 * is that abandoned branches are still there, and a result on one of them has
 * its call on the same branch.
 */
function indexToolCalls(roots: SessionTreeNode[]): Map<string, TreeNodeTool> {
    const calls = new Map<string, TreeNodeTool>();
    const stack = [...roots];
    while (stack.length > 0) {
        const node = stack.pop()!;
        const entry = node.entry;
        if (entry.type === "message" && entry.role === "assistant") {
            for (const block of blocksOf(entry.content)) {
                if (block.type === "tool-call" && block.toolCallId) {
                    calls.set(block.toolCallId, {
                        name: block.toolName ?? "tool",
                        input: block.input ?? {},
                    });
                }
            }
        }
        for (const child of node.children) stack.push(child);
    }
    return calls;
}

function toolsOf(content: unknown, calls: Map<string, TreeNodeTool>): TreeNodeTool[] {
    const tools: TreeNodeTool[] = [];
    for (const block of blocksOf(content)) {
        if (block.type === "tool-call") {
            tools.push({ name: block.toolName ?? "tool", input: block.input ?? {} });
        } else if (block.type === "tool-result") {
            const call = block.toolCallId ? calls.get(block.toolCallId) : undefined;
            tools.push(call ?? { name: block.toolName ?? "tool", input: {} });
        }
    }
    return tools;
}

/**
 * Which subtrees contain the current leaf.
 *
 * Used to order siblings so the branch you are ON comes first. Post-order over
 * an explicitly built pre-order list rather than recursion, because a session
 * can be thousands of entries deep and this must not blow the stack.
 */
function markContainsActive(
    roots: SessionTreeNode[],
    leafId: string | null,
): Map<SessionTreeNode, boolean> {
    const contains = new Map<SessionTreeNode, boolean>();
    const all: SessionTreeNode[] = [];
    const stack = [...roots];
    while (stack.length > 0) {
        const node = stack.pop()!;
        all.push(node);
        for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]!);
    }
    for (let i = all.length - 1; i >= 0; i -= 1) {
        const node = all[i]!;
        let has = leafId !== null && node.entry.id === leafId;
        for (const child of node.children) if (contains.get(child)) has = true;
        contains.set(node, has);
    }
    return contains;
}

/**
 * Where a child sits relative to its parent.
 *
 * Ported from the TUI's `/tree` (packages/cli/src/interactive/ui/tree/
 * layout.ts `childLayout`), because the rule is what makes the view readable
 * and the two surfaces must not disagree about the shape of the same session:
 *
 *   - a parent that branches puts its children one level in;
 *   - the generation right after a branch also steps in, which visually groups
 *     the subtree under the fork;
 *   - a single-child chain stays flat.
 *
 * That last line is the whole point. A conversation is a chain with occasional
 * detours, so indenting per ancestor turns an ordinary session into a diagonal
 * and says nothing — every step of a run is at the same place in the story.
 */
function childIndent(indent: number, justBranched: boolean, multipleChildren: boolean): number {
    if (multipleChildren) return indent + 1;
    if (justBranched && indent > 0) return indent + 1;
    return indent;
}

/** Flatten a session's tree into rows a client can list. */
export function buildSessionTreeView(session: Session): SessionTreeView {
    const roots = session.getTree();
    const calls = indexToolCalls(roots);
    // Only ids, not entries: the path can be long and this is a membership
    // test run once per row.
    const onPath = new Set<string>();
    for (const entry of session.getBranch()) if (entry.id) onPath.add(entry.id);

    const leafId = session.getLeafId();
    const containsActive = markContainsActive(roots, leafId);
    const rows: SessionTreeRow[] = [];
    const branchPointIds: string[] = [];

    // Orphaned entries come back as extra roots; more than one means the tree
    // itself forks at the top, so the roots are treated as siblings.
    const multipleRoots = roots.length > 1;
    interface Frame {
        node: SessionTreeNode;
        depth: number;
        indent: number;
        justBranched: boolean;
        branchStart: boolean;
        lastSibling: boolean;
    }

    /** Active branch first, original order within each group. */
    const order = (nodes: readonly SessionTreeNode[]): SessionTreeNode[] => {
        const active: SessionTreeNode[] = [];
        const rest: SessionTreeNode[] = [];
        for (const node of nodes) (containsActive.get(node) ? active : rest).push(node);
        return [...active, ...rest];
    };

    const stack: Frame[] = [];
    const orderedRoots = order(roots);
    for (let i = orderedRoots.length - 1; i >= 0; i -= 1) {
        stack.push({
            node: orderedRoots[i]!,
            depth: 0,
            indent: 0,
            justBranched: multipleRoots,
            branchStart: multipleRoots,
            lastSibling: i === orderedRoots.length - 1,
        });
    }

    while (stack.length > 0) {
        const frame = stack.pop()!;
        const { node, depth, indent } = frame;
        const entry = node.entry;
        if (!entry.id) continue;

        const raw = entry.type === "message" ? stripSessionHookContext(textOf(entry.content)) : "";
        const trimmed = raw.replace(/\s+/g, " ").trim();
        const tools =
            entry.type === "message" && entry.role !== "user" ? toolsOf(entry.content, calls) : [];

        rows.push({
            id: entry.id,
            parentId: entry.parentId ?? null,
            ts: entry.ts,
            type: entry.type,
            ...(entry.type === "message" ? { role: entry.role } : {}),
            ...(trimmed === "" ? {} : { text: trimmed.slice(0, MAX_TEXT_LEN) }),
            ...(trimmed.length > MAX_TEXT_LEN ? { truncated: true } : {}),
            ...(tools.length === 0 ? {} : { tools }),
            ...(node.label === undefined ? {} : { label: node.label }),
            indent,
            depth,
            ...(frame.branchStart ? { branchStart: true } : {}),
            ...(frame.branchStart && frame.lastSibling ? { lastSibling: true } : {}),
            onPath: onPath.has(entry.id),
            childCount: node.children.length,
            ...((entry as { interrupted?: boolean }).interrupted ? { interrupted: true } : {}),
        });
        if (node.children.length > 1) branchPointIds.push(entry.id);

        const children = order(node.children);
        const branches = children.length > 1;
        const nextIndent = childIndent(indent, frame.justBranched, branches);
        for (let i = children.length - 1; i >= 0; i -= 1) {
            stack.push({
                node: children[i]!,
                depth: depth + 1,
                indent: nextIndent,
                justBranched: branches,
                branchStart: branches,
                lastSibling: i === children.length - 1,
            });
        }
    }

    return { leafId, rows, branchPointIds };
}
