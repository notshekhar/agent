import { describe, expect, test } from "bun:test";
import type { TodoItem } from "@notshekhar/loop-core";
import { formatTodoPanel, TodoPanel } from "../src/interactive/components/todo-panel";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]): string[] => lines.map((l) => l.replace(ANSI_RE, ""));

const item = (content: string, status: TodoItem["status"] = "pending", activeForm?: string): TodoItem => ({
    content,
    status,
    ...(activeForm ? { activeForm } : {}),
});

describe("formatTodoPanel", () => {
    test("empty list renders no rows", () => {
        expect(formatTodoPanel([], 80)).toEqual([]);
    });

    test("header carries the done/total count and fills the width with a rule", () => {
        const lines = plain(formatTodoPanel([item("a", "completed"), item("b")], 40));
        expect(lines[0]).toStartWith("─ todos (1/2) ");
        expect(lines[0].length).toBe(40);
        expect(lines[0].endsWith("─")).toBe(true);
    });

    test("status markers: [ ] pending, [>] in_progress, [x] completed", () => {
        const lines = plain(
            formatTodoPanel([item("read", "completed"), item("wire", "in_progress"), item("test")], 60),
        );
        expect(lines[1]).toBe("[x] read");
        expect(lines[2]).toBe("[>] wire");
        expect(lines[3]).toBe("[ ] test");
    });

    test("cancelled renders as a [-] row", () => {
        const lines = plain(formatTodoPanel([item("dropped", "cancelled"), item("next")], 60));
        expect(lines[1]).toBe("[-] dropped");
        expect(lines[2]).toBe("[ ] next");
    });

    test("in_progress shows activeForm when present", () => {
        const lines = plain(formatTodoPanel([item("wire handler", "in_progress", "wiring handler")], 60));
        expect(lines[1]).toBe("[>] wiring handler");
    });

    test("long rows clip to width with an ellipsis", () => {
        const lines = plain(formatTodoPanel([item("x".repeat(100))], 20));
        expect(lines[1].length).toBeLessThanOrEqual(20);
        expect(lines[1].endsWith("…")).toBe(true);
    });

    test("overflow keeps in_progress + pending and adds a +N more row", () => {
        const items = [
            ...Array.from({ length: 5 }, (_, i) => item(`done ${i}`, "completed")),
            item("active", "in_progress"),
            ...Array.from({ length: 4 }, (_, i) => item(`next ${i}`)),
        ];
        const lines = plain(formatTodoPanel(items, 60, 6));
        expect(lines.length).toBe(1 + 6); // header + 5 items + "+N more"
        expect(lines.some((l) => l.includes("[>] active"))).toBe(true);
        expect(lines.at(-1)).toBe("    +5 more");
        // Every pending item beats older completed ones into the panel.
        expect(lines.filter((l) => l.includes("[ ] next")).length).toBe(4);
    });

    test("small lists render every item with no more-row", () => {
        const lines = plain(formatTodoPanel([item("a"), item("b")], 60, 6));
        expect(lines.length).toBe(3);
        expect(lines.some((l) => l.includes("more"))).toBe(false);
    });
});

describe("TodoPanel", () => {
    test("allCompleted treats cancelled as terminal", () => {
        const p = new TodoPanel();
        p.setItems([item("a", "completed"), item("b", "cancelled")]);
        expect(p.allCompleted()).toBe(true);
        p.setItems([item("a", "completed"), item("b", "cancelled"), item("c")]);
        expect(p.allCompleted()).toBe(false);
    });

    test("setItems/clear drive render and allCompleted", () => {
        const p = new TodoPanel();
        expect(p.render(80)).toEqual([]);
        expect(p.allCompleted()).toBe(false);
        p.setItems([item("a", "completed"), item("b", "completed")]);
        expect(p.allCompleted()).toBe(true);
        expect(p.count()).toBe(2);
        expect(p.render(80).length).toBe(3);
        p.clear();
        expect(p.render(80)).toEqual([]);
        expect(p.isEmpty()).toBe(true);
    });
});
