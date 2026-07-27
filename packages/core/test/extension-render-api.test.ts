import { describe, expect, test } from "bun:test";
import type { ExtensionTheme, ToolSummaryContext } from "../src/extensions/api";
import { summarizeLspCall } from "../src/extensions/builtin/lsp/index";

/** A theme that marks what it styled, so assertions can see the calls. */
const markerTheme: ExtensionTheme = {
    name: "test",
    fg: (slot, text) => `<${slot}>${text}</${slot}>`,
    bg: (slot, text) => `<bg:${slot}>${text}</bg:${slot}>`,
    bold: (text) => `<b>${text}</b>`,
    italic: (text) => `<i>${text}</i>`,
    underline: (text) => `<u>${text}</u>`,
};

const ctx = (uiMode: string): ToolSummaryContext => ({
    toolName: "lsp",
    cwd: "/proj",
    uiMode,
    theme: markerTheme,
});

describe("lsp renders its own call summary", () => {
    test("a position operation shows operation and file:line:col", () => {
        const out = summarizeLspCall(
            { operation: "goToDefinition", filePath: "/proj/src/main.ts", line: 4, character: 23 },
            ctx("loop"),
        );
        expect(out).toContain("goToDefinition");
        expect(out).toContain("src/main.ts:4:23");
        // The path is shown relative to cwd, not absolute.
        expect(out).not.toContain("/proj/src");
    });

    test("workspaceSymbol shows the query instead of a position", () => {
        expect(
            summarizeLspCall({ operation: "workspaceSymbol", filePath: "/proj/a.ts", query: "greet" }, ctx("loop")),
        ).toContain('"greet"');
        expect(
            summarizeLspCall({ operation: "workspaceSymbol", filePath: "/proj/a.ts", query: "" }, ctx("loop")),
        ).toContain("(all symbols)");
    });

    test("documentSymbol shows just the file", () => {
        const out = summarizeLspCall({ operation: "documentSymbol", filePath: "/proj/src/a.ts" }, ctx("loop"));
        expect(out).toContain("src/a.ts");
        expect(out).not.toMatch(/:\d+:\d+/);
    });

    test("colors come from the supplied theme, never hardcoded", () => {
        const out = summarizeLspCall(
            { operation: "hover", filePath: "/proj/a.ts", line: 1, character: 1 },
            ctx("loop"),
        );
        expect(out).toContain("<muted>");
    });

    test("noir gets a bolder operation than loop — the modes differ", () => {
        const args = { operation: "hover", filePath: "/proj/a.ts", line: 1, character: 1 };
        const noir = summarizeLspCall(args, ctx("noir"));
        const loop = summarizeLspCall(args, ctx("loop"));
        expect(noir).toContain("<b>hover</b>");
        expect(loop).not.toContain("<b>");
        expect(noir).not.toBe(loop);
    });

    test("garbage arguments still render something, never throw", () => {
        expect(() => summarizeLspCall({}, ctx("loop"))).not.toThrow();
        expect(summarizeLspCall({}, ctx("loop"))).toContain("lsp");
    });
});
