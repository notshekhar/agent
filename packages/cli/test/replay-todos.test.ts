import { beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

// Pin the color pipeline before the theme module reads COLORTERM.
process.env.COLORTERM = "truecolor";

import { getSessionTodos, TODOS_KIND, type Session, type TodoItem } from "@notshekhar/loop-core";
import { renderSessionBranch } from "../src/interactive/replay";
import { ChatHistory } from "../src/interactive/components/chat-history";
import { TodoPanel } from "../src/interactive/components/todo-panel";
import { initTheme } from "../src/interactive/ui/theme";

beforeAll(() => initTheme("dark"));

const tui = { requestRender() {} } as unknown as TUI;

const items: TodoItem[] = [
    { content: "wire the handler", status: "completed" },
    { content: "test it", status: "in_progress", activeForm: "testing it" },
];

const fakeSession = (id: string, entries: unknown[]): Session =>
    ({ id, getBranch: () => entries }) as unknown as Session;

describe("renderSessionBranch todo seeding", () => {
    test("resume seeds the core map alongside the pinned panel", () => {
        const entries = [
            { type: "message", role: "user", content: "do the thing", ts: 1, id: "u1", parentId: null },
            { type: "custom", ts: 2, payload: { kind: TODOS_KIND, items }, id: "c1", parentId: "u1" },
        ];
        const panel = new TodoPanel();
        renderSessionBranch(fakeSession("seed-test-1", entries), new ChatHistory(tui, "/repo"), "xai/grok-4.5", panel);
        // Both views of the checklist agree: the pinned panel AND the map the
        // staleness nudger + RPC readers consult (empty after a process
        // restart before this seeding existed).
        expect(panel.isEmpty()).toBe(false);
        expect(getSessionTodos("seed-test-1")).toEqual(items);
    });

    test("a branch without todos clears stale map state", () => {
        const withTodos = [{ type: "custom", ts: 1, payload: { kind: TODOS_KIND, items }, id: "c1", parentId: null }];
        renderSessionBranch(
            fakeSession("seed-test-2", withTodos),
            new ChatHistory(tui, "/repo"),
            "xai/grok-4.5",
            new TodoPanel(),
        );
        expect(getSessionTodos("seed-test-2")).toEqual(items);

        // Navigating to a todo-less branch of the same session drops the seed.
        const bare = [{ type: "message", role: "user", content: "hi", ts: 1, id: "u1", parentId: null }];
        const panel = new TodoPanel();
        renderSessionBranch(fakeSession("seed-test-2", bare), new ChatHistory(tui, "/repo"), "xai/grok-4.5", panel);
        expect(getSessionTodos("seed-test-2")).toEqual([]);
        expect(panel.isEmpty()).toBe(true);
    });
});
