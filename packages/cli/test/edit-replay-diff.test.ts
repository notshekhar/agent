import { beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";
import { ToolExecutionComponent } from "../src/interactive/ui/tool-execution";
import { initTheme } from "../src/interactive/ui/theme";

beforeAll(() => initTheme("dark"));

const tui = { requestRender() {} } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");

const args = { path: "src/a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] };

/** A finished edit row, expanded so nothing is folded away. */
const row = (output: string) => {
    const c = new ToolExecutionComponent("edit", args, tui, "/repo");
    c.updateResult({ content: [{ type: "text", text: output }], isError: false }, false);
    c.setExpanded(true);
    return c.render(80).map(strip).join("\n");
};

describe("a replayed edit still shows what it changed", () => {
    test("a live result keeps its own real diff and gains nothing", () => {
        const live = "Successfully replaced 1 block(s) in src/a.ts.\n\n-12 const a = 1;\n+12 const a = 2;";
        const text = row(live);
        expect(text).toContain("-12 const a = 1;");
        expect(text).toContain("+12 const a = 2;");
        // The real diff's line numbers survive; no numberless copy rides along.
        expect(text).not.toContain("-const a = 1;");
    });

    test("a replayed result rebuilds the diff from the call's own arguments", () => {
        // What toModelOutput persists: the summary, and nothing else.
        const text = row("Successfully replaced 1 block(s) in src/a.ts.");
        expect(text).toContain("Successfully replaced 1 block(s)");
        expect(text).toContain("-const a = 1;");
        expect(text).toContain("+const a = 2;");
    });

    test("a failed edit is not dressed up as a change that landed", () => {
        const c = new ToolExecutionComponent("edit", args, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "Could not find the exact text" }], isError: true }, false);
        c.setExpanded(true);
        const text = c.render(80).map(strip).join("\n");
        expect(text).not.toContain("+const a = 2;");
    });
});
