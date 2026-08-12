import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { registerNoirMode, DAY_THEME, NIGHT_THEME } from "../src/interactive/ui/noir-mode";
import { setActiveUiMode, uiStyle } from "../src/interactive/ui/ui-mode";
import { initTheme, Theme, theme } from "../src/interactive/ui/theme";
import { applyCanvasWash, resetCanvasWash } from "../src/interactive/ui/canvas-wash";
import { AssistantMessageComponent, UserMessageComponent } from "../src/interactive/ui/messages";
import { ToolExecutionComponent } from "../src/interactive/ui/tool-execution";
import { ChatHistory } from "../src/interactive/components/chat-history";
import { setAnimTickForTest } from "../src/interactive/ui/anim";

beforeAll(() => {
    registerNoirMode();
});

afterEach(() => {
    setActiveUiMode("loop");
    initTheme("dark");
});

const noirOn = () => {
    setActiveUiMode("noir");
    initTheme("night");
};

const tui = { requestRender() {} } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const W = 80;

/** The truecolor SGR the active theme emits for a slot — so colour assertions
 * say "this element uses the warning slot", not "warning is #e5c07b", and
 * survive a repaint of the palette. */
const sgr = (slot: Parameters<typeof theme.fg>[0]) => {
    const hex = theme.raw(slot) as string;
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `\x1b[38;2;${rgb.join(";")}m`;
};

describe("noir mode themes", () => {
    test("night theme resolves the wash color", () => {
        const t = new Theme(NIGHT_THEME);
        expect(t.raw("bgBase")).toBe("#141414");
        expect(t.raw("bgRaised")).toBe("#1f1f21");
    });

    test("initTheme finds night via the active mode's theme set", () => {
        noirOn();
        expect(theme.raw("bgBase")).toBe("#141414");
    });

    test("loop mode cannot see noir's themes (falls back to dark)", () => {
        setActiveUiMode("loop");
        initTheme("night"); // not a loop theme, not a custom file → fallback
        expect(theme.name).toBe("dark");
    });
});

describe("noir mode style spec", () => {
    test("resolves the noir knobs over loop defaults", () => {
        noirOn();
        const s = uiStyle();
        expect(s.canvas.wash).toBe(true);
        expect(s.thinking.display).toBe("block");
        expect(s.thinking.collapseOnFinish).toBe(true);
        expect(s.tool.bullet).toBe("◆");
        expect(s.tool.mutedCollapsed).toBe(true);
        expect(s.userMessage.prefix).toBe("❯");
        expect(s.turn.summaryLine).toBe(true);
        // untouched knobs keep loop values
        expect(s.tool.collapsedLines).toBe(6);
    });
});

describe("noir mode rendering", () => {
    test("user message gets the ❯ prefix", () => {
        noirOn();
        const text = new UserMessageComponent("hello").render(W).map(strip).join("\n");
        expect(text).toContain("❯ hello");
    });

    test("thinking streams a 3-line tail with the gutter", () => {
        noirOn();
        const c = new AssistantMessageComponent({
            content: [{ type: "thinking", thinking: "l1\nl2\nl3\nl4\nl5" }],
            stopReason: "stop",
        });
        const lines = c.render(W).map(strip);
        // The rail now runs the full block, header included — the tail is the
        // railed lines that aren't the header.
        const body = lines.filter((l) => l.includes("┃") && !l.includes("Thinking…"));
        expect(body).toHaveLength(3);
        expect(body[0]).toContain("l3");
        expect(body[2]).toContain("l5");
        expect(lines.join("\n")).toContain("Thinking…");
    });

    test("thinking collapses to a Thought-for row once done, reopens on expand", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.appendAssistantThinking("secret reasoning here", "p", "m");
        h.finishAssistant();
        const collapsed = h.render(W).map(strip).join("\n");
        expect(collapsed).toMatch(/◆ Thought for \d/);
        expect(collapsed).not.toContain("secret reasoning here");
        h.setToolsExpanded(true);
        const expanded = h.render(W).map(strip).join("\n");
        expect(expanded).toContain("secret reasoning here");
    });

    test("individual selection expands one thinking block only", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.appendAssistantThinking("first thought", "p", "m");
        h.appendAssistantDelta("interlude", "p", "m");
        h.appendAssistantThinking("second thought", "p", "m");
        h.finishAssistant();
        // select last foldable (second thinking), expand just it
        expect(h.moveSelection(-1)).toBe(true);
        expect(h.toggleSelected()).toBe(true);
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("second thought");
        expect(text).not.toContain("first thought");
        // selection bar present; esc clears it
        expect(h.render(W).join("\n")).toContain("▌");
        expect(h.clearSelection()).toBe(true);
        expect(h.clearSelection()).toBe(false);
    });

    test("individual selection expands one tool call only", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("bash", "c1", { command: "echo one" });
        h.addToolResult("c1", "OUT-ONE");
        h.addToolCall("bash", "c2", { command: "echo two" });
        h.addToolResult("c2", "OUT-TWO");
        h.moveSelection(-1); // selects c2 (most recent)
        h.moveSelection(-1); // walk up to c1
        h.toggleSelected();
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("OUT-ONE");
        expect(text).not.toContain("OUT-TWO");
    });

    test("noir tool row is flat: one muted line folded, gutter output expanded", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "seq 3" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "1\n2\n3" }], isError: false }, false);
        const folded = c.render(W).map(strip);
        // lead blank (groupLead) + the single row
        expect(folded).toHaveLength(2);
        expect(folded[0]).toBe("");
        expect(folded[1]).toContain("◆ bash seq 3");
        c.setExpanded(true);
        const open = c.render(W).map(strip).join("\n");
        expect(open).toContain("┃  1");
        expect(open).toContain("┃  3");
    });

    test("tool groups: lead gap after text, tight rows inside the group", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.appendAssistantDelta("Some intro text.", "p", "m");
        h.addToolCall("bash", "g1", { command: "echo a" });
        h.addToolResult("g1", "a");
        h.addToolCall("bash", "g2", { command: "echo b" });
        h.addToolResult("g2", "b");
        const plain = h.render(W).map(strip);
        const t1 = plain.findIndex((l) => l.includes("◆ bash echo a"));
        const t2 = plain.findIndex((l) => l.includes("◆ bash echo b"));
        // blank line between the text and the first tool row
        expect(plain[t1 - 1].trim()).toBe("");
        // consecutive tool rows stay adjacent
        expect(t2).toBe(t1 + 1);
    });

    test("failed tool rows fold like the rest; expanding shows the error", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "false" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false);
        expect(c.render(W).map(strip).join("\n")).not.toContain("boom");
        c.setExpanded(true);
        expect(c.render(W).map(strip).join("\n")).toContain("boom");
    });

    test("tool diamond carries the state color: done green, failed red", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "x" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        expect(c.render(W).join("\n")).toContain(`${sgr("success")}◆`);
        const f = new ToolExecutionComponent("bash", { command: "x" }, tui, "/repo");
        f.updateResult({ content: [{ type: "text", text: "no" }], isError: true }, false);
        expect(f.render(W).join("\n")).toContain(`${sgr("toolError")}◆`);
    });

    test("a running tool's diamond and rail ride the animation wave", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "x" }, tui, "/repo");
        // Running rows are painted from a computed blend, not a fixed slot, so
        // the bullet can pulse in step with its rail.
        const at = (t: number): string => {
            setAnimTickForTest(t);
            return c.render(W).join("\n");
        };
        // A quarter-cycle of the wave is the brightest→dimmest swing; the two
        // frames must not paint identically or nothing is actually animating.
        expect(at(0)).not.toBe(at(Math.round(Math.PI / 2 / (0.15 * 1.5))));
        expect(at(0)).toContain("◆");
        expect(at(0)).toContain("┃");
        setAnimTickForTest(0);
    });

    test("user turns and responses are selectable; alt jumps between turns", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("first question");
        h.appendAssistantDelta("first answer", "p", "m");
        h.finishAssistant();
        h.addUser("second question");
        h.appendAssistantDelta("second answer", "p", "m");
        h.finishAssistant();
        // Selection renders as a left accent bar on every line of the entry
        // (constant height/width — a border box made the layout shift).
        const markerNear = (needle: string): boolean => {
            const plain = h.render(W).map(strip);
            const at = plain.findIndex((l) => l.includes(needle));
            return at >= 0 && plain[at].trimStart().startsWith("▌");
        };
        // jumpTurn from nothing lands on the latest user turn
        expect(h.jumpTurn(-1)).toBe(true);
        expect(markerNear("second question")).toBe(true);
        // jump again → first user turn
        expect(h.jumpTurn(-1)).toBe(true);
        expect(markerNear("first question")).toBe(true);
        expect(markerNear("second question")).toBe(false);
        // no earlier turn to jump to
        expect(h.jumpTurn(-1)).toBe(false);
    });

    test("responses are selectable but never fold", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("go");
        h.appendAssistantDelta("l1\nl2\nl3\nl4\nl5\nl6", "p", "m");
        h.finishAssistant();
        h.moveSelection(-1); // response is the latest entry
        expect(h.toggleSelected()).toBe(true); // consumed, but a no-op
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("l1");
        expect(text).toContain("l6");
        expect(h.setSelectedExpanded(false)).toBe(true); // also a no-op
        expect(h.render(W).map(strip).join("\n")).toContain("l6");
    });

    test("REGRESSION: a streaming turn must not drag the nav window to the bottom", () => {
        noirOn();
        const smallTui = { requestRender() {}, terminal: { rows: 18 } } as unknown as TUI;
        const h = new ChatHistory(smallTui, "/repo");
        for (let i = 0; i < 15; i++) {
            h.addToolCall("bash", `c${i}`, { command: `echo ${i}` });
            h.addToolResult(`c${i}`, String(i));
        }
        h.setViewport(true);
        h.selectLast();
        h.render(W); // anchor consumed here
        // user scrolls up to read history
        h.scrollViewportLines(-8);
        const before = h.render(W).map(strip);
        // a turn streams in: growing response text + more entries below
        for (let i = 0; i < 30; i++) h.appendAssistantDelta(`stream line ${i}\n`, "p", "m");
        const after = h.render(W).map(strip);
        // the window must NOT move — same first visible content line
        expect(after[1]).toBe(before[1]);
        // moving the selection re-anchors deliberately (one user action)
        h.moveSelection(1);
        const anchored = h.render(W).map(strip).join("\n");
        expect(anchored).not.toBe(after.join("\n"));
    });

    test("nav scroll cache: identical output, no stale content, and actually fast", () => {
        noirOn();
        const smallTui = { requestRender() {}, terminal: { rows: 20 } } as unknown as TUI;
        const h = new ChatHistory(smallTui, "/repo");
        for (let i = 0; i < 120; i++) {
            h.addToolCall("bash", `c${i}`, { command: `echo entry-${i}` });
            h.addToolResult(`c${i}`, `out-${i}`);
        }
        h.setViewport(true);
        h.selectLast();
        h.render(W);
        // cached scroll renders must equal a cold (dirty) render of the same offset
        h.scrollViewportLines(-40);
        const cached = h.render(W).join("\n");
        (h as unknown as { markDirty(): void }).markDirty();
        const cold = h.render(W).join("\n");
        expect(cached).toBe(cold);
        // a streaming mutation busts the cache — new content appears
        h.scrollViewportEdge("bottom");
        h.render(W);
        h.appendAssistantDelta("fresh-delta-text", "p", "m");
        h.scrollViewportEdge("bottom");
        expect(h.render(W).join("\n")).toContain("fresh-delta-text");
        // cached scrolling is at least 5x faster than dirty re-renders
        const t0 = performance.now();
        for (let i = 0; i < 50; i++) {
            h.scrollViewportLines(i % 2 === 0 ? -5 : 5);
            h.render(W);
        }
        const cachedMs = performance.now() - t0;
        const t1 = performance.now();
        for (let i = 0; i < 50; i++) {
            (h as unknown as { markDirty(): void }).markDirty();
            h.scrollViewportLines(i % 2 === 0 ? -5 : 5);
            h.render(W);
        }
        const dirtyMs = performance.now() - t1;
        expect(cachedMs * 5).toBeLessThan(dirtyMs);
    });

    test("an entry taller than the window pins to its top (no ping-pong)", () => {
        noirOn();
        const smallTui = { requestRender() {}, terminal: { rows: 18 } } as unknown as TUI;
        const h = new ChatHistory(smallTui, "/repo");
        h.addToolCall("bash", "c0", { command: "echo pad" });
        h.addToolResult("c0", "pad");
        h.addToolCall("bash", "c1", { command: "seq 40" });
        h.addToolResult("c1", Array.from({ length: 40 }, (_, i) => String(i + 1)).join("\n"));
        h.setViewport(true);
        h.selectLast();
        h.toggleSelected(); // expand: entry is now ~41 lines vs a 10-row window
        const first = h.render(W).map(strip);
        const again = h.render(W).map(strip);
        const third = h.render(W).map(strip);
        // stable across renders — the old logic oscillated top/bottom
        expect(again).toEqual(first);
        expect(third).toEqual(first);
        // pinned to the entry's top: the header row is visible
        expect(first.join("\n")).toContain("◆ bash seq 40");
    });

    test("a long user message folds the same way", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("q1\nq2\nq3\nq4\nq5\nq6");
        h.jumpTurn(-1);
        h.toggleSelected();
        const folded = h.render(W).map(strip).join("\n");
        expect(folded).not.toContain("q6");
        expect(folded).toMatch(/\+\d+ lines/);
        h.toggleSelected();
        expect(h.render(W).map(strip).join("\n")).toContain("q6");
    });

    test("selection renders as a stable left bar — no height/width change", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("bash", "c1", { command: "echo hi" });
        h.addToolResult("c1", "hi");
        const unselectedHeight = h.render(W).length;
        h.selectLast();
        const lines = h.render(W);
        // selecting must not shift the layout
        expect(lines.length).toBe(unselectedHeight);
        const plain = lines.map(strip);
        const row = plain.findIndex((l) => l.includes("◆ bash echo hi"));
        expect(row).toBeGreaterThan(-1);
        expect(plain[row].trimStart().startsWith("▌")).toBe(true);
        h.clearSelection();
        expect(h.render(W).length).toBe(unselectedHeight);
    });

    test("scrollback-focus primitives: selectLast, left/right fold, y-copy text", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("do it");
        h.addToolCall("bash", "c1", { command: "seq 2" });
        h.addToolResult("c1", "1\n2");
        expect(h.getSelectedText()).toBeNull();
        expect(h.selectLast()).toBe(true);
        expect(h.hasSelection()).toBe(true);
        // right = expand, left = fold
        expect(h.setSelectedExpanded(true)).toBe(true);
        // The selection spine and the rail share column 0 — a selected entry
        // wears "▌" where its rail would be, so nothing shifts sideways.
        expect(h.render(W).map(strip).join("\n")).toContain("▌  1");
        expect(h.setSelectedExpanded(false)).toBe(true);
        expect(h.render(W).map(strip).join("\n")).not.toContain("┃ 1");
        // y copies the call + output
        expect(h.getSelectedText()).toBe("bash seq 2\n1\n2");
        // user entry copy
        h.jumpTurn(-1);
        expect(h.getSelectedText()).toBe("do it");
    });

    test("timestamps: user box and finished response carry h:MM AM/PM", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("hello", new Date(2026, 6, 9, 21, 10).getTime());
        h.appendAssistantDelta("world", "p", "m");
        h.finishAssistant();
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("9:10 PM");
        // response line ends with a right-aligned time (component-created, so
        // just assert the format is present on the response line too)
        const respLine = h
            .render(W)
            .map(strip)
            .find((l) => l.includes("world"));
        expect(respLine).toMatch(/\d{1,2}:\d{2} [AP]M\s*$/);
    });

    test("loop mode renders no timestamps (knob off)", () => {
        setActiveUiMode("loop");
        initTheme("dark");
        const h = new ChatHistory(tui, "/repo");
        h.addUser("hello", new Date(2026, 6, 9, 21, 10).getTime());
        expect(h.render(W).map(strip).join("\n")).not.toContain("9:10 PM");
    });

    test("nav viewport: window follows the selection and clips with indicators", () => {
        noirOn();
        const smallTui = { requestRender() {}, terminal: { rows: 20 } } as unknown as TUI;
        const h = new ChatHistory(smallTui, "/repo");
        // 30 tool rows -> far taller than the 12-row window (20 - 8)
        for (let i = 0; i < 30; i++) {
            h.addToolCall("bash", `c${i}`, { command: `echo ${i}` });
            h.addToolResult(`c${i}`, String(i));
        }
        // no viewport: full height
        expect(h.render(W).length).toBeGreaterThanOrEqual(30);
        h.setViewport(true);
        h.selectLast();
        let win = h.render(W);
        expect(win.length).toBeLessThanOrEqual(12);
        let plain = win.map(strip);
        // bottom entry selected: window is anchored at the bottom, top clipped
        expect(plain[0]).toContain("▲");
        expect(plain.join("\n")).toContain("echo 29");
        // walk far up: window follows, bottom becomes clipped
        for (let i = 0; i < 25; i++) h.moveSelection(-1);
        plain = h.render(W).map(strip);
        expect(plain.join("\n")).toContain("echo 4");
        expect(plain.join("\n")).not.toContain("echo 29");
        expect(plain[plain.length - 1]).toContain("▼");
        // manual scroll releases follow; selection move re-engages
        h.scrollViewportLines(h.viewportPage());
        const scrolled = h.render(W).map(strip).join("\n");
        expect(scrolled).not.toContain("echo 4 ");
        h.moveSelection(-1);
        expect(h.render(W).map(strip).join("\n")).toContain("echo 3");
        // expand-all keeps the selection in view (no fling to bottom)
        h.setToolsExpanded(true);
        expect(h.render(W).map(strip).join("\n")).toContain("echo 3");
        // exit: full height again
        h.setViewport(false);
        expect(h.render(W).length).toBeGreaterThanOrEqual(30);
    });

    test("replayed thinking keeps its persisted duration (reasoningMs)", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        // replay path: duration passed straight through instead of wall clock
        h.appendAssistantThinking("old reasoning", "p", "m", 3200);
        h.finishAssistant();
        expect(h.render(W).map(strip).join("\n")).toContain("◆ Thought for 3.2s");
    });

    test("durations round on unit boundaries (59.7s is 1m00s, not 60s)", () => {
        noirOn();
        const render = (ms: number): string => {
            const h = new ChatHistory(tui, "/repo");
            h.appendAssistantThinking("r", "p", "m", ms);
            h.finishAssistant();
            return h.render(W).map(strip).join("\n");
        };
        expect(render(59700)).toContain("Thought for 1m00s");
        expect(render(119700)).toContain("Thought for 2m00s");
        expect(render(41000)).toContain("Thought for 41s");
    });

    test("REGRESSION: long tool headers truncate — never exceed the width (crash guard)", () => {
        noirOn();
        const long =
            "find /some/deeply/nested/path -name '*.ts' -not -path node_modules -exec grep -l 'pattern' {} \\; | head -50";
        const c = new ToolExecutionComponent("bash", { command: long }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        for (const sel of [false, true]) {
            c.setSelected(sel);
            for (const l of c.render(W)) {
                expect(strip(l).length).toBeLessThanOrEqual(W);
            }
        }
        // thinking headers with the selected hint fit too
        const h = new ChatHistory(tui, "/repo");
        h.appendAssistantThinking("x", "p", "m");
        h.finishAssistant();
        h.selectLast();
        for (const l of h.render(40)) expect(strip(l).length).toBeLessThanOrEqual(40);
    });

    test("click selects the entry under the line, through the viewport window", () => {
        noirOn();
        const smallTui = { requestRender() {}, terminal: { rows: 20 } } as unknown as TUI;
        const h = new ChatHistory(smallTui, "/repo");
        h.addUser("question");
        for (let i = 0; i < 20; i++) {
            h.addToolCall("bash", `c${i}`, { command: `echo ${i}` });
            h.addToolResult(`c${i}`, String(i));
        }
        // full render (no viewport): clicking a tool row's line selects it
        const plain = h.render(W).map(strip);
        const rowOf = (needle: string) => plain.findIndex((l) => l.includes(needle));
        expect(h.clickAtLocalLine(rowOf("echo 5"))).toBe(true);
        expect(h.getSelectedText()).toBe("bash echo 5\n5");
        // spacer/gap lines miss cleanly
        expect(h.clickAtLocalLine(0)).toBe(false);
        // windowed: local lines shift by the window offset + indicator row
        h.setViewport(true);
        h.selectLast();
        const win = h.render(W).map(strip);
        const winRow = win.findIndex((l) => l.includes("echo 15"));
        expect(winRow).toBeGreaterThan(0);
        expect(h.clickAtLocalLine(winRow)).toBe(true);
        expect(h.getSelectedText()).toBe("bash echo 15\n15");
        // indicator rows are not clickable
        expect(h.clickAtLocalLine(0)).toBe(false);
    });

    test("noir spacing invariant: single blank between blocks, never double", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("do the thing");
        h.appendAssistantThinking("plan it", "p", "m");
        h.appendAssistantDelta("Intro text.", "p", "m");
        h.addToolCall("bash", "c1", { command: "echo a" });
        h.addToolResult("c1", "a");
        h.addToolCall("bash", "c2", { command: "echo b" });
        h.addToolResult("c2", "b");
        h.appendAssistantDelta("Outro text.", "p", "m");
        h.finishAssistant();
        h.addTurnSummary(3);
        const plain = h.render(W).map((l) => strip(l).trim());
        // no two consecutive TRULY blank lines after the user box (the box's
        // bg-painted padding rows strip to blank but render colored)
        const afterBox = plain.findIndex((l) => l.includes("◆ Thought"));
        for (let i = afterBox + 1; i < plain.length; i++) {
            expect(`${i}:${plain[i - 1]}|${plain[i]}`).not.toBe(`${i}:|`);
        }
        // exactly one blank between the thought row and the text block
        const thought = plain.findIndex((l) => l.includes("◆ Thought"));
        const intro = plain.findIndex((l) => l.includes("Intro text."));
        expect(intro - thought).toBe(2);
        // tools tight within the group, one blank before the group
        const t1 = plain.findIndex((l) => l.includes("◆ bash echo a"));
        const t2 = plain.findIndex((l) => l.includes("◆ bash echo b"));
        expect(t2).toBe(t1 + 1);
        expect(plain[t1 - 1]).toBe("");
    });

    test("replay renders a step's text before its subagent boxes (live order)", async () => {
        noirOn();
        const { renderSessionBranch } = await import("../src/interactive/replay");
        const entries = [
            { type: "message", role: "user", content: "explore it", ts: 1, id: "u1", parentId: null },
            // subagent finished (persisted) BEFORE the step's assistant message
            {
                type: "subagent",
                ts: 2,
                agent: "explore",
                prompt: "look around",
                result: "found things",
                id: "s1",
                parentId: "u1",
            },
            {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "Fanning out subagents." }],
                ts: 3,
                id: "a1",
                parentId: "s1",
            },
        ];
        const fakeSession = {
            getBranch: () => entries,
        } as unknown as import("@notshekhar/loop-core").Session;
        const h = new ChatHistory(tui, "/repo");
        renderSessionBranch(fakeSession, h, "xai/grok-4.5");
        const plain = h.render(W).map(strip);
        const text = plain.findIndex((l) => l.includes("Fanning out subagents."));
        const task = plain.findIndex((l) => l.includes("◆ task explore"));
        expect(text).toBeGreaterThan(-1);
        expect(task).toBeGreaterThan(text); // text first, task boxes after — like live
    });

    test("replay keeps parallel subagents persisted in the same millisecond as separate boxes", async () => {
        noirOn();
        const { renderSessionBranch } = await import("../src/interactive/replay");
        // Two fan-out runs that finished in the same ms share a replay id
        // (ts-keyed). That's safe today only because each box's result is
        // resolved before the next call registers — this pins that invariant.
        const sub = (id: string, agent: string, result: string, parentId: string) => ({
            type: "subagent",
            ts: 2,
            agent,
            prompt: `${agent} it`,
            result,
            id,
            parentId,
        });
        const entries = [
            { type: "message", role: "user", content: "explore it", ts: 1, id: "u1", parentId: null },
            sub("s1", "explore", "found alpha", "u1"),
            sub("s2", "review", "found beta", "s1"),
            {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "Done." }],
                ts: 3,
                id: "a1",
                parentId: "s2",
            },
        ];
        const fakeSession = {
            getBranch: () => entries,
        } as unknown as import("@notshekhar/loop-core").Session;
        const h = new ChatHistory(tui, "/repo");
        renderSessionBranch(fakeSession, h, "xai/grok-4.5");
        h.toggleToolsExpanded(); // expand so both reports are visible
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("◆ task explore");
        expect(text).toContain("◆ task review");
        expect(text).toContain("found alpha");
        expect(text).toContain("found beta");
    });

    test("aborting a turn freezes pending tools as interrupted", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("bash", "c1", { command: "sleep 100" });
        // no result — turn gets aborted
        h.markPendingToolsInterrupted();
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("· interrupted");
        // and the finished-tool path is untouched
        const h2 = new ChatHistory(tui, "/repo");
        h2.addToolCall("bash", "c2", { command: "echo hi" });
        h2.addToolResult("c2", "hi");
        h2.markPendingToolsInterrupted();
        expect(h2.render(W).map(strip).join("\n")).not.toContain("interrupted");
    });

    test("day theme carries the higher-contrast palette", () => {
        const t = new Theme(DAY_THEME);
        expect(t.raw("bgBase")).toBe("#fcfcfc");
        expect(t.raw("muted")).toBe("#71717b");
        // Noir holds the brand blue at its own set's lightness rather than the
        // full-chroma primary loop mode uses.
        expect(t.raw("selectionBorder")).toBe("#3463a6");
    });

    test("plan keeps the default box look in noir mode (approval surface)", () => {
        noirOn();
        const plan = new ToolExecutionComponent("plan", { plan: "# P" }, tui, "/repo");
        plan.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        // default renderer = multi-line box with bg padding
        expect(plan.render(W).length).toBeGreaterThan(2);
    });

    test("subagent renders as a noir row: live status+tail, stats title, expanded log", () => {
        noirOn();
        const c = new ToolExecutionComponent("task", { agent: "explore", prompt: "find the auth code" }, tui, "/repo");
        // live: status in the title, activity tail under the gutter
        c.updateStatus("read src/auth.ts · step 3 · 12s");
        c.updateResult(
            { content: [{ type: "text", text: "> ls .\n> read src/auth.ts\nfound it" }], isError: false },
            true,
        );
        const live = c.render(W).map(strip);
        expect(live[0]).toBe(""); // lead blank (groupLead)
        expect(live[1]).toContain("◆ task explore");
        expect(live[1]).toContain("read src/auth.ts · step 3 · 12s");
        expect(live[1]).toContain("find the auth code");
        // last-3 tail under the gutter while running
        expect(live.filter((l) => l.includes("┃") && !l.includes("◆"))).toHaveLength(3);
        // done: stats in the title, log hidden until expanded
        c.setTaskStats({ steps: 3, durationMs: 41000, usd: 0.043 });
        c.updateResult(
            { content: [{ type: "text", text: "> ls .\n> read src/auth.ts\nreport line" }], isError: false },
            false,
        );
        const folded = c.render(W).map(strip);
        expect(folded).toHaveLength(2);
        expect(folded[1]).toContain("done · 3 steps · 41s · $0.0430");
        c.setExpanded(true);
        const open = c.render(W).map(strip).join("\n");
        expect(open).toContain("┃  > ls .");
        expect(open).toContain("┃  report line");
    });

    test("tool title gets the diamond and greys out when folded-done", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "ls" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        const raw = c.render(W).join("\n");
        expect(strip(raw)).toContain("◆ bash");
        // the muted slot, not the bright toolTitle
        expect(raw).toContain(sgr("muted"));
    });

    test("turn summary line renders through the turnSummary slot", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addTurnSummary(14.2);
        expect(h.render(W).map(strip).join("\n")).toContain("Turn completed in 14s.");
        h.addTurnSummary(83);
        expect(h.render(W).map(strip).join("\n")).toContain("Turn completed in 1m23s.");
    });

    test("loop mode rendering is untouched by grok being registered", () => {
        initTheme("dark");
        const c = new AssistantMessageComponent({
            content: [{ type: "thinking", thinking: "inline italic thinking" }],
            stopReason: "stop",
        });
        const text = c.render(W).map(strip).join("\n");
        expect(text).toContain("inline italic thinking");
        expect(text).not.toContain("┃");
        expect(text).not.toContain("Thinking…");
    });
});

describe("canvas wash", () => {
    const fakeOut = () => {
        const writes: string[] = [];
        return { writes, stream: { write: (s: string) => (writes.push(s), true) } as unknown as NodeJS.WriteStream };
    };

    test("grok mode washes bg+fg with OSC 11/10 and restores with OSC 111/110", () => {
        noirOn();
        const { writes, stream } = fakeOut();
        applyCanvasWash(stream);
        expect(writes).toEqual(["\x1b]11;#141414\x07", "\x1b]10;#f5f5f5\x07"]);
        resetCanvasWash(stream);
        expect(writes).toEqual(["\x1b]11;#141414\x07", "\x1b]10;#f5f5f5\x07", "\x1b]111\x07", "\x1b]110\x07"]);
    });

    test("loop mode does not wash, and un-washes a previous wash", () => {
        noirOn();
        const { writes, stream } = fakeOut();
        applyCanvasWash(stream);
        setActiveUiMode("loop");
        initTheme("dark");
        applyCanvasWash(stream); // wash off now → emits the reset
        expect(writes).toEqual(["\x1b]11;#141414\x07", "\x1b]10;#f5f5f5\x07", "\x1b]111\x07", "\x1b]110\x07"]);
        resetCanvasWash(stream); // already reset → no-op
        expect(writes).toHaveLength(4);
    });
});

describe("noir read rows", () => {
    test("the row carries the offset/limit range the summary drops", () => {
        noirOn();
        const c = new ToolExecutionComponent("read", { path: "/repo/src/a.ts", offset: 120, limit: 3 }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "x\ny\nz" }], isError: false }, false);
        const row = c.render(W).map(strip).join("\n");
        expect(row).toContain("◆ read src/a.ts:120-122");
    });

    test("a whole-file read has no range suffix", () => {
        noirOn();
        const c = new ToolExecutionComponent("read", { path: "/repo/src/a.ts" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "x" }], isError: false }, false);
        expect(c.render(W).map(strip).join("\n")).toContain("◆ read src/a.ts");
        expect(c.render(W).map(strip).join("\n")).not.toContain(":");
    });

    test("expanded output is numbered from the offset", () => {
        noirOn();
        const c = new ToolExecutionComponent("read", { path: "/repo/src/a.ts", offset: 9, limit: 2 }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "const x = 1;\nexport default x;" }], isError: false }, false);
        c.setExpanded(true);
        const open = c.render(W).map(strip).join("\n");
        expect(open).toContain("┃   9  const x = 1;");
        expect(open).toContain("┃  10  export default x;");
    });

    test("other tools' output is never numbered", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "seq 2" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "1\n2" }], isError: false }, false);
        c.setExpanded(true);
        const open = c.render(W).map(strip).join("\n");
        expect(open).toContain("┃  1");
        expect(open).not.toContain("┃  1  1");
    });
});
