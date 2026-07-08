import { describe, expect, test } from "bun:test";
import { isTodosPayload, latestTodos, validateTodos, type TodoItem } from "../src/tools/todo";

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
        expect(latestTodos([{ type: "message" }, { type: "custom", payload: { kind: "recap", text: "x" } }])).toBeNull();
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
