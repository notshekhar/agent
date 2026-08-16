import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { setActiveUiMode } from "../src/interactive/ui/ui-mode";
import { initTheme } from "../src/interactive/ui/theme";
import { ChatHistory } from "../src/interactive/components/chat-history";

const ROWS = 24;
const W = 70;

let terminal = { rows: ROWS, columns: 80 };
const tui = {
    requestRender() {},
    get terminal() {
        return terminal;
    },
} as unknown as TUI;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const lines = (h: ChatHistory) => h.render(W).map(strip);

beforeEach(() => {
    terminal = { rows: ROWS, columns: 80 };
    setActiveUiMode("loop");
    initTheme("dark");
});

afterEach(() => {
    setActiveUiMode("loop");
    initTheme("dark");
});

function history(messages: number): ChatHistory {
    const h = new ChatHistory(tui, "/repo");
    for (let i = 0; i < messages; i++) h.addSystem(`line ${i}`);
    return h;
}

describe("pinned input — holding the prompt down", () => {
    test("a short transcript is padded so the frame fills the screen", () => {
        const h = history(3);
        h.setReserveRows(() => 8);
        h.setPinned(true);
        // Window + chrome == the terminal, so the prompt lands on the last rows.
        expect(lines(h).length + 8).toBe(ROWS);
    });

    test("the pad tracks the chrome, which moves as the draft grows", () => {
        const h = history(3);
        let chrome = 8;
        h.setReserveRows(() => chrome);
        h.setPinned(true);
        expect(lines(h).length + chrome).toBe(ROWS);
        chrome = 14;
        expect(lines(h).length + chrome).toBe(ROWS);
    });

    test("an empty session pins too", () => {
        const h = new ChatHistory(tui, "/repo");
        h.setReserveRows(() => 8);
        h.setPinned(true);
        expect(lines(h).length + 8).toBe(ROWS);
    });

    test("the transcript sits at the bottom of the pad, next to the prompt", () => {
        const h = new ChatHistory(tui, "/repo");
        h.addSystem("first thing said");
        h.setReserveRows(() => 8);
        h.setPinned(true);
        const out = lines(h);
        expect(out[0]).toBe("");
        expect(out[out.length - 1]).toContain("first thing said");
    });

    test("a transcript taller than the screen is handed over whole", () => {
        // Nothing to pad, and nothing to clip: the terminal scrolls it, which
        // is what puts everything above into real scrollback where the wheel
        // and the mouse can reach it.
        const h = history(60);
        h.setReserveRows(() => 8);
        h.setPinned(true);
        const out = lines(h);
        expect(out.length).toBeGreaterThan(ROWS);
        expect(out.join("\n")).toContain("line 0");
        expect(out.join("\n")).toContain("line 59");
    });

    test("unpinned, a short transcript is left exactly as it is", () => {
        const h = history(3);
        h.setReserveRows(() => 8);
        expect(lines(h).length).toBeLessThan(ROWS - 8);
    });

    test("a resize re-budgets the pad", () => {
        const h = history(3);
        h.setReserveRows(() => 8);
        h.setPinned(true);
        expect(lines(h).length + 8).toBe(ROWS);
        terminal = { rows: 40, columns: 80 };
        expect(lines(h).length + 8).toBe(40);
    });
});

describe("pinned input — what it must NOT take from the terminal", () => {
    // The first cut of this feature owned the scrolling, which meant asking
    // for mouse reporting to get the wheel, which is exactly what stops a
    // terminal drag-selecting text. grok's TUI does not own the scroll and
    // keeps all three. These guard the property, not the implementation.
    const appSource = readFileSync(join(import.meta.dir, "..", "src", "interactive", "app.ts"), "utf8");
    const inputSource = readFileSync(join(import.meta.dir, "..", "src", "interactive", "input-handler.ts"), "utf8");

    test("pinning never asks the terminal for mouse reporting", () => {
        expect(appSource).not.toContain("?1006h");
        expect(appSource).not.toContain("?1000h");
        expect(appSource).not.toContain("?1002h");
    });

    test("only navigation mode asks for it, and gives it straight back", () => {
        // Nav mode is a mode you enter and leave; holding the mouse for the
        // length of a session is what was unacceptable.
        expect(inputSource).toContain("enterScrollbackFocus");
        const enter = inputSource.slice(inputSource.indexOf("const enterScrollbackFocus"));
        expect(enter).toContain("?1006h");
        const exit = inputSource.slice(inputSource.indexOf("const exitScrollbackFocus"));
        expect(exit).toContain("?1000l");
    });

    test("pinning does not clip the transcript into a loop-owned window", () => {
        // A clipped window is scrollback loop has taken away from the
        // terminal: the wheel stops reaching it and the text stops being
        // selectable, which is the whole trade this feature refuses to make.
        const h = history(60);
        h.setReserveRows(() => 8);
        h.setPinned(true);
        expect(lines(h).join("\n")).not.toMatch(/more lines?/);
    });
});

describe("a frame that shrinks pulls its content back down", () => {
    // The general defect behind every version of this bug: a shrinking frame
    // (a menu closing, a panel going away) had its trailing rows cleared where
    // they were, leaving the prompt mid-screen with a gap beneath it. The lines
    // that belong in those rows were never lost — they are in the same array
    // being rendered — so the renderer repaints the visible window from them
    // instead, which needs no per-command patch and clears nothing.
    const settings = readFileSync(
        join(import.meta.dir, "..", "src", "interactive", "handlers", "settings-handlers.ts"),
        "utf8",
    );
    const tuiSource = readFileSync(join(import.meta.dir, "..", "..", "tui", "src", "tui.ts"), "utf8");

    test("no command patches the layout on its way out any more", () => {
        // v0.19.5 fixed /settings alone by repainting on close, which cleared
        // the scrollback to do it (measured: two ESC[3J per toggle).
        expect(settings).not.toContain("repaintOnClose");
    });

    test("the fix lives in the renderer, so every selector gets it", () => {
        expect(tuiSource).toContain("newLines.length < this.previousLines.length");
    });

    test("and it does not reach for the scrollback-clearing redraw", () => {
        // The shrink branch hands off to the shared window repaint...
        const shrink = tuiSource.slice(tuiSource.indexOf("newLines.length < this.previousLines.length"));
        expect(shrink.slice(0, 400)).toContain("this.repaintVisibleWindow(");
        expect(shrink.slice(0, 400)).not.toContain("fullRender(true)");
        // ...and that repaint clears rows, never the screen or the scrollback.
        const repaint = tuiSource.slice(tuiSource.indexOf("private repaintVisibleWindow("));
        const body = repaint.slice(0, repaint.indexOf("\n    }"));
        expect(body).not.toContain("fullRender");
        expect(body).not.toContain("\\x1b[3J");
        expect(body).not.toContain("\\x1b[2J");
    });
});

describe("navigation mode still owns its window", () => {
    test("Tab's viewport still clips and still shows how much is off-screen", () => {
        const h = history(60);
        h.setReserveRows(() => 8);
        h.setViewport(true);
        const out = lines(h);
        expect(out.length).toBe(ROWS - 8);
        expect(out.join("\n")).toMatch(/▲ \d+ more lines/);
    });

    test("scrolling the nav window still works", () => {
        const h = history(60);
        h.setReserveRows(() => 8);
        h.setViewport(true);
        lines(h);
        h.scrollViewportLines(-10);
        expect(lines(h).join("\n")).toMatch(/▼ \d+ more lines/);
    });

    test("leaving navigation gives the whole transcript back", () => {
        const h = history(60);
        h.setReserveRows(() => 8);
        h.setViewport(true);
        expect(lines(h).length).toBe(ROWS - 8);
        h.setViewport(false);
        expect(lines(h).length).toBeGreaterThan(ROWS);
    });

    test("pinned and navigating at once still fills the screen exactly", () => {
        const h = history(60);
        h.setReserveRows(() => 8);
        h.setPinned(true);
        h.setViewport(true);
        expect(lines(h).length + 8).toBe(ROWS);
    });
});
