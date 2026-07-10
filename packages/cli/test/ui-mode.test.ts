import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";
import {
    activeUiMode,
    getUiMode,
    listUiModes,
    LOOP_STYLE,
    registerUiMode,
    setActiveUiMode,
    uiRenderers,
    uiStyle,
    unregisterUiMode,
} from "../src/interactive/ui/ui-mode";
import { DARK_THEME } from "../src/interactive/ui/themes";
import { ToolExecutionComponent } from "../src/interactive/ui/tool-execution";
import { UserMessageComponent } from "../src/interactive/ui/messages";
import { initTheme, theme } from "../src/interactive/ui/theme";

beforeAll(() => initTheme("dark"));

afterEach(() => {
    setActiveUiMode("loop");
    unregisterUiMode("test-mode");
});

const tui = { requestRender() {} } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");

const testMode = (style?: Parameters<typeof registerUiMode>[0]["style"]) => ({
    id: "test-mode",
    themes: [DARK_THEME],
    style,
});

describe("ui mode registry", () => {
    test("loop is registered, active, and resolves to the loop defaults", () => {
        expect(activeUiMode().id).toBe("loop");
        expect(uiStyle()).toEqual(LOOP_STYLE);
        expect(uiRenderers()).toEqual({});
        expect(listUiModes().map((m) => m.id)).toContain("loop");
    });

    test("a partial style layers over loop defaults without clobbering siblings", () => {
        registerUiMode(testMode({ thinking: { display: "block", collapseOnFinish: true }, canvas: { wash: true } }));
        expect(setActiveUiMode("test-mode")).toBe(true);
        const s = uiStyle();
        expect(s.thinking.display).toBe("block");
        expect(s.thinking.collapseOnFinish).toBe(true);
        // untouched keys keep loop values
        expect(s.thinking.liveTailLines).toBe(LOOP_STYLE.thinking.liveTailLines);
        expect(s.canvas.wash).toBe(true);
        expect(s.tool).toEqual(LOOP_STYLE.tool);
    });

    test("unknown mode is refused and the active mode is unchanged", () => {
        expect(setActiveUiMode("nope")).toBe(false);
        expect(activeUiMode().id).toBe("loop");
    });

    test("unregistering the active mode falls back to loop", () => {
        registerUiMode(testMode({ canvas: { wash: true } }));
        setActiveUiMode("test-mode");
        expect(uiStyle().canvas.wash).toBe(true);
        unregisterUiMode("test-mode");
        expect(activeUiMode().id).toBe("loop");
        expect(uiStyle().canvas.wash).toBe(false);
        expect(getUiMode("test-mode")).toBeUndefined();
    });

    test("loop itself cannot be unregistered", () => {
        unregisterUiMode("loop");
        expect(activeUiMode().id).toBe("loop");
    });

    test("re-registering the active mode picks up new style (cache invalidated)", () => {
        registerUiMode(testMode({ canvas: { wash: false } }));
        setActiveUiMode("test-mode");
        expect(uiStyle().canvas.wash).toBe(false);
        registerUiMode(testMode({ canvas: { wash: true } }));
        expect(uiStyle().canvas.wash).toBe(true);
    });
});

describe("components consume the active mode", () => {
    test("tool.collapsedLines + hints.expandHint drive the collapsed preview", () => {
        registerUiMode({
            id: "test-mode",
            themes: [DARK_THEME],
            style: { tool: { collapsedLines: 2 }, hints: { expandHint: "F9" } },
        });
        setActiveUiMode("test-mode");
        const c = new ToolExecutionComponent("bash", { command: "seq 5" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "1\n2\n3\n4\n5" }], isError: false }, false);
        const text = c.render(80).map(strip).join("\n");
        expect(text).toContain("… +3 lines (F9 to expand)");
        // only the first 2 output lines survive the fold
        expect(text).not.toMatch(/^ 3\s*$/m);
    });

    test("tool.bullet prefixes the title", () => {
        registerUiMode({ id: "test-mode", themes: [DARK_THEME], style: { tool: { bullet: "◆" } } });
        setActiveUiMode("test-mode");
        const c = new ToolExecutionComponent("bash", { command: "ls" }, tui, "/repo");
        const text = c.render(80).map(strip).join("\n");
        expect(text).toContain("◆ bash");
    });

    test("a toolExecution renderer fully replaces the box", () => {
        registerUiMode({
            id: "test-mode",
            themes: [DARK_THEME],
            render: { toolExecution: (s, ctx) => [`<${s.toolName} w${ctx.width} partial=${s.isPartial}>`] },
        });
        setActiveUiMode("test-mode");
        const c = new ToolExecutionComponent("bash", { command: "ls" }, tui, "/repo");
        expect(c.render(42)).toEqual(["<bash w42 partial=true>"]);
    });

    test("a userMessage renderer replaces the box but keeps OSC zones", () => {
        registerUiMode({
            id: "test-mode",
            themes: [DARK_THEME],
            render: { userMessage: (s) => [`> ${s.text}`] },
        });
        setActiveUiMode("test-mode");
        const lines = new UserMessageComponent("hello").render(80);
        expect(lines[0]).toContain("> hello");
        expect(lines[0]).toContain("\x1b]133;A\x07");
    });

    test("userMessage.prefix is applied by the default renderer", () => {
        registerUiMode({ id: "test-mode", themes: [DARK_THEME], style: { userMessage: { prefix: "❯" } } });
        setActiveUiMode("test-mode");
        const text = new UserMessageComponent("hello").render(80).map(strip).join("\n");
        expect(text).toContain("❯ hello");
    });
});

describe("mode themes fall back to dark for missing slots", () => {
    test("a minimal mode theme (no optional slots) renders instead of throwing", () => {
        // An extension theme that only sets what it cares about — the slots
        // the type marks optional (selectionBorder, timestamp, …) are absent.
        const { selectionBorder: _sb, timestamp: _ts, ...colors } = DARK_THEME.colors as Record<string, unknown>;
        registerUiMode({
            id: "test-mode",
            themes: [{ name: "minimal", vars: DARK_THEME.vars, colors } as unknown as typeof DARK_THEME],
        });
        setActiveUiMode("test-mode");
        initTheme("minimal");
        expect(theme.name).toBe("minimal"); // loaded, not the fallback theme
        // Would throw "Unknown theme color" without the dark fallback merge.
        expect(theme.fg("selectionBorder", "x")).toContain("x");
        expect(theme.fg("timestamp", "t")).toContain("t");
        initTheme("dark");
    });
});
