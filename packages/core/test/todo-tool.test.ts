import { describe, expect, test } from "bun:test";
import {
    createTodoNudger,
    formatTodoList,
    hasActiveTodos,
    isTodosPayload,
    latestTodos,
    TODO_NUDGE_STALE_AFTER,
    TODO_NUDGE_START_AFTER,
    TODO_TOOL_NAME,
    validateTodos,
    type TodoItem,
} from "../src/tools/todo";

const item = (content: string, status: TodoItem["status"] = "pending", activeForm?: string): TodoItem => ({
    content,
    status,
    ...(activeForm ? { activeForm } : {}),
});

describe("validateTodos", () => {
    test("accepts a normal list with one in_progress", () => {
        expect(
            validateTodos([item("read code", "completed"), item("wire handler", "in_progress"), item("add tests")]),
        ).toBeNull();
    });

    test("accepts an empty list (clears the checklist)", () => {
        expect(validateTodos([])).toBeNull();
    });

    test("accepts a list with no in_progress item", () => {
        expect(validateTodos([item("a"), item("b", "completed")])).toBeNull();
    });

    test("rejects two in_progress items", () => {
        const err = validateTodos([item("a", "in_progress"), item("b", "in_progress")]);
        expect(err).toStartWith("REJECTED:");
        expect(err).toContain("in_progress");
    });

    test("rejects empty/whitespace content", () => {
        expect(validateTodos([item("a"), item("   ")])).toStartWith("REJECTED:");
    });

    test("rejects more than 50 items", () => {
        const many = Array.from({ length: 51 }, (_, i) => item(`step ${i}`));
        expect(validateTodos(many)).toStartWith("REJECTED:");
    });

    test("accepts cancelled items", () => {
        expect(validateTodos([item("a", "cancelled"), item("b", "in_progress")])).toBeNull();
    });
});

describe("formatTodoList", () => {
    test("numbers items with their status", () => {
        expect(formatTodoList([item("read code", "completed"), item("wire handler", "in_progress")])).toBe(
            "1. [completed] read code\n2. [in_progress] wire handler",
        );
    });
});

describe("hasActiveTodos", () => {
    test("true when any item is pending or in_progress", () => {
        expect(hasActiveTodos([item("a", "completed"), item("b")])).toBe(true);
        expect(hasActiveTodos([item("a", "in_progress")])).toBe(true);
    });

    test("false for empty and all-terminal lists", () => {
        expect(hasActiveTodos([])).toBe(false);
        expect(hasActiveTodos([item("a", "completed"), item("b", "cancelled")])).toBe(false);
    });
});

describe("createTodoNudger", () => {
    const calls = (n: number, name = "bash") => Array.from({ length: n }, () => name);

    test("stale active list nudges after the threshold, then backs off", () => {
        const items = [item("a", "in_progress")];
        const nudge = createTodoNudger(() => items);
        expect(nudge(calls(TODO_NUDGE_STALE_AFTER - 1))).toBeNull();
        expect(nudge(calls(TODO_NUDGE_STALE_AFTER))).toContain("todo list has not been updated");
        // Immediately after a nudge: quiet until another threshold's worth of calls.
        expect(nudge(calls(TODO_NUDGE_STALE_AFTER + 3))).toBeNull();
        expect(nudge(calls(TODO_NUDGE_STALE_AFTER * 2))).toContain("todo list has not been updated");
    });

    test("a todo write resets the staleness counter", () => {
        const items = [item("a", "in_progress")];
        const nudge = createTodoNudger(() => items);
        const history = [...calls(TODO_NUDGE_STALE_AFTER - 1), TODO_TOOL_NAME, ...calls(3)];
        expect(nudge(history)).toBeNull();
    });

    test("listless long turns get exactly one create-a-list nudge", () => {
        const nudge = createTodoNudger(() => []);
        expect(nudge(calls(TODO_NUDGE_START_AFTER - 1))).toBeNull();
        expect(nudge(calls(TODO_NUDGE_START_AFTER))).toContain("without a todo list");
        expect(nudge(calls(TODO_NUDGE_START_AFTER * 3))).toBeNull();
    });

    test("no start nudge once a todo write happened, even if the list emptied", () => {
        const nudge = createTodoNudger(() => []);
        expect(nudge([TODO_TOOL_NAME, ...calls(TODO_NUDGE_START_AFTER + 5)])).toBeNull();
    });

    test("all-terminal list neither stale-nudges nor start-nudges after a write", () => {
        const items = [item("a", "completed"), item("b", "cancelled")];
        const nudge = createTodoNudger(() => items);
        expect(nudge([TODO_TOOL_NAME, ...calls(TODO_NUDGE_START_AFTER * 2)])).toBeNull();
    });
});

describe("isTodosPayload", () => {
    test("accepts the persisted shape", () => {
        expect(isTodosPayload({ kind: "todos", items: [] })).toBe(true);
        expect(isTodosPayload({ kind: "todos", items: [item("a")] })).toBe(true);
    });

    test("rejects other customs and junk", () => {
        expect(isTodosPayload({ kind: "recap", text: "hi" })).toBe(false);
        expect(isTodosPayload({ kind: "todos", items: "nope" })).toBe(false);
        expect(isTodosPayload(null)).toBe(false);
        expect(isTodosPayload(undefined)).toBe(false);
        expect(isTodosPayload("todos")).toBe(false);
    });
});

describe("latestTodos", () => {
    test("null when the branch never had a list", () => {
        expect(
            latestTodos([{ type: "message" }, { type: "custom", payload: { kind: "recap", text: "x" } }]),
        ).toBeNull();
    });

    test("returns the most recent todos payload, skipping later non-todo customs", () => {
        const first = [item("old", "completed")];
        const second = [item("new", "in_progress")];
        const entries = [
            { type: "custom", payload: { kind: "todos", items: first } },
            { type: "message" },
            { type: "custom", payload: { kind: "todos", items: second } },
            { type: "custom", payload: { kind: "recap", text: "r" } },
        ];
        expect(latestTodos(entries)).toEqual(second);
    });

    test("an empty persisted list wins over an earlier non-empty one", () => {
        const entries = [
            { type: "custom", payload: { kind: "todos", items: [item("a")] } },
            { type: "custom", payload: { kind: "todos", items: [] } },
        ];
        expect(latestTodos(entries)).toEqual([]);
    });
});
