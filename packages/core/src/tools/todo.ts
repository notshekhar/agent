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

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

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

/**
 * Seed the canonical map from a replayed branch — resume/fork/tree navigation
 * and the startup --resume render. Without this the map is empty after a
 * process restart while the pinned panel shows the persisted list, so the
 * staleness nudger and RPC readers disagree with what's on screen. An empty
 * list clears the key, so switching to a branch without todos drops stale state.
 */
export function seedSessionTodos(sessionId: string, items: TodoItem[]): void {
    if (items.length > 0) sessionTodos.set(sessionId, [...items]);
    else sessionTodos.delete(sessionId);
}

function summarize(items: TodoItem[]): string {
    if (items.length === 0) return "Todo list cleared.";
    const count = (s: TodoStatus) => items.filter((t) => t.status === s).length;
    const cancelled = count("cancelled");
    return (
        `Todo list updated: ${count("completed")} completed, ${count("in_progress")} in progress, ` +
        `${count("pending")} pending${cancelled > 0 ? `, ${cancelled} cancelled` : ""}.`
    );
}

/**
 * The numbered plain-text list echoed back as the tool result (and re-injected
 * after compaction). Echo-on-write is why there's no separate read tool: the
 * latest state always lives in a tool result the model re-reads.
 */
export function formatTodoList(items: TodoItem[]): string {
    return items.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
}

/** True when the list still has work on it (any pending or in_progress item). */
export function hasActiveTodos(items: TodoItem[]): boolean {
    return items.some((t) => t.status === "pending" || t.status === "in_progress");
}

/** Tool calls on a stale active list before each staleness re-nudge. */
export const TODO_NUDGE_STALE_AFTER = 10;
/** Tool calls into a listless turn before the single create-a-list nudge. */
export const TODO_NUDGE_START_AFTER = 15;

const STALE_NUDGE =
    "<system-reminder>The todo list has not been updated in a while. If steps are finished, mark them " +
    "completed now (resend the full list); if the plan changed, update or cancel items to match. " +
    "Ignore if the list is still accurate.</system-reminder>";

const START_NUDGE =
    "<system-reminder>This task has run for many tool calls without a todo list. If the remaining work has " +
    "3+ distinct steps, create one with the todo tool so progress stays visible. Ignore if the work is " +
    "nearly done or genuinely single-step.</system-reminder>";

/**
 * Per-turn staleness nudger (prepareStep seam). Given every tool call so far
 * this turn (in order), returns a reminder to append to the next request — or
 * null. The reminder is ephemeral: it rides one request's messages and is
 * never persisted, so it can't bust the prompt-cache prefix. Active lists
 * re-nudge every TODO_NUDGE_STALE_AFTER calls; the create-a-list nudge fires
 * at most once per turn.
 */
export function createTodoNudger(getItems: () => TodoItem[]): (toolCallsSoFar: string[]) => string | null {
    let lastNudgeAt = 0;
    let startNudged = false;
    return (toolCallsSoFar: string[]) => {
        const total = toolCallsSoFar.length;
        const lastWrite = toolCallsSoFar.lastIndexOf(TODO_TOOL_NAME);
        const sinceWrite = lastWrite === -1 ? total : total - lastWrite - 1;
        const items = getItems();
        if (hasActiveTodos(items)) {
            if (sinceWrite >= TODO_NUDGE_STALE_AFTER && total - lastNudgeAt >= TODO_NUDGE_STALE_AFTER) {
                lastNudgeAt = total;
                return STALE_NUDGE;
            }
            return null;
        }
        // No list (or nothing left on it): one gentle prompt to start one.
        if (!startNudged && lastWrite === -1 && total >= TODO_NUDGE_START_AFTER) {
            startNudged = true;
            lastNudgeAt = total;
            return START_NUDGE;
        }
        return null;
    };
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
            "resend every item, updated. An empty list clears the checklist.\n\n" +
            "Use it when the work has 3+ distinct steps, the user gives multiple tasks, or new instructions " +
            "arrive mid-task (capture them as todos). Skip it for single-step or purely informational " +
            "requests. When in doubt, use it.\n\n" +
            "Rules:\n" +
            "- Keep exactly ONE item in_progress while work remains; mark it before starting the step.\n" +
            "- Mark a step completed the moment it is actually done and verified — never on intent, never " +
            "batched at the end.\n" +
            "- If a step is blocked, keep it in_progress and add a follow-up todo describing the blocker.\n" +
            "- Add follow-ups discovered during the work; mark abandoned steps cancelled instead of " +
            "deleting or fake-completing them.\n" +
            "- Preserve user-provided commands verbatim (flags, args, order).\n" +
            "- Items should be specific and actionable; break large work into smaller steps.",
        inputSchema: z.object({
            todos: z
                .array(
                    z.object({
                        content: z.string().describe("Imperative step description, e.g. 'Add session middleware'."),
                        status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
                        activeForm: z
                            .string()
                            .optional()
                            .describe(
                                "Present-continuous label shown while in progress, e.g. 'Adding session middleware'.",
                            ),
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
            // Echo the list back (opencode/gemini pattern): the model's memory
            // of its own list then lives in a tool result it re-reads, instead
            // of only in prior tool-call arguments.
            return todos.length === 0 ? summarize(todos) : `${summarize(todos)}\n${formatTodoList(todos)}`;
        },
    });
}
