/**
 * todo — the agent's visible checklist for long multi-step turns. Each call
 * replaces the whole list (no ids, no diff ops — the model just restates it),
 * the TUI renders it as a pinned panel above the editor, and every accepted
 * write persists as a custom session entry so /resume, /fork and /tree restore
 * the branch's latest list. Conditionally attached in runTurn (todos setting,
 * default OFF) AFTER the task tool, so subagents never inherit it — parallel
 * subagents writing one pinned panel would fight the parent.
 */
import { tool } from "ai";
import { z } from "zod";
import type { TurnEmitter } from "../agent/events";
import type { Session } from "../sessions";

export const TODO_TOOL_NAME = "todo";

export const TODOS_KIND = "todos";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
    /** Imperative description of the step ("Add session middleware"). */
    content: string;
    status: TodoStatus;
    /** Present-continuous label shown while in progress ("Adding session middleware"). */
    activeForm?: string;
}

/** Shape of the custom entry payload a todo write persists as. */
export interface TodosPayload {
    kind: typeof TODOS_KIND;
    items: TodoItem[];
}

const MAX_ITEMS = 50;

export function isTodosPayload(payload: unknown): payload is TodosPayload {
    const p = payload as TodosPayload | null;
    return !!p && typeof p === "object" && p.kind === TODOS_KIND && Array.isArray(p.items);
}

/**
 * Semantic checks zod can't express. Returns a rejection string (sent back as
 * the tool result so the model self-corrects, plan.ts pattern) or null when
 * the list is acceptable. An empty list is valid — it clears the checklist.
 */
export function validateTodos(items: TodoItem[]): string | null {
    if (items.length > MAX_ITEMS) {
        return `REJECTED: ${items.length} items is too many (max ${MAX_ITEMS}). Track the plan at a coarser grain.`;
    }
    if (items.some((t) => !t.content.trim())) {
        return "REJECTED: every todo needs non-empty content. Resend the full list with each item described.";
    }
    const inProgress = items.filter((t) => t.status === "in_progress").length;
    if (inProgress > 1) {
        return `REJECTED: ${inProgress} items are in_progress — keep exactly one step in progress at a time. Resend the full list.`;
    }
    return null;
}

/** Minimal Entry slice — avoids importing the full union just to scan it. */
interface EntryLike {
    type: string;
    payload?: unknown;
}

/**
 * The branch's most recent todo list, or null when it never had one. Used to
 * seed the pinned panel on /resume, /fork and /tree navigation.
 */
export function latestTodos(entries: EntryLike[]): TodoItem[] | null {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type === "custom" && isTodosPayload(e.payload)) return e.payload.items;
    }
    return null;
}

// Canonical latest list per session — lets non-UI consumers (RPC clients,
// remote control) query the current checklist without replaying the session.
const sessionTodos = new Map<string, TodoItem[]>();

export function getSessionTodos(sessionId: string): TodoItem[] {
    return sessionTodos.get(sessionId) ?? [];
}

export function clearSessionTodos(sessionId: string): void {
    sessionTodos.delete(sessionId);
}

function summarize(items: TodoItem[]): string {
    if (items.length === 0) return "Todo list cleared.";
    const count = (s: TodoStatus) => items.filter((t) => t.status === s).length;
    return `Todo list updated: ${count("completed")} completed, ${count("in_progress")} in progress, ${count("pending")} pending.`;
}

export interface TodoToolContext {
    sessionId: string;
    session: Session;
    emitter: TurnEmitter;
}

export function createTodoTool(ctx: TodoToolContext) {
    return tool({
        description:
            "Maintain your visible task checklist for the current job. Each call REPLACES the whole list — " +
            "resend every item, updated. Use it for multi-step work (3+ distinct steps): create the list when " +
            "you start, keep exactly ONE item in_progress, and mark a step completed immediately when it is " +
            "done — do not batch completions. Skip it for trivial single-step requests. " +
            "An empty list clears the checklist.",
        inputSchema: z.object({
            todos: z
                .array(
                    z.object({
                        content: z.string().describe("Imperative step description, e.g. 'Add session middleware'."),
                        status: z.enum(["pending", "in_progress", "completed"]),
                        activeForm: z
                            .string()
                            .optional()
                            .describe("Present-continuous label shown while in progress, e.g. 'Adding session middleware'."),
                    }),
                )
                .describe("The complete, current list — this replaces the previous one."),
        }),
        execute: async ({ todos }) => {
            const rejection = validateTodos(todos);
            if (rejection) return rejection;
            sessionTodos.set(ctx.sessionId, todos);
            ctx.emitter.emit("todo-update", { items: todos });
            const payload: TodosPayload = { kind: TODOS_KIND, items: todos };
            await ctx.session.append({ type: "custom", ts: Date.now(), payload });
            return summarize(todos);
        },
    });
}
