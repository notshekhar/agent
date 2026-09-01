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

describe("what the transcript must never take from the terminal", () => {
    // loop does not own the scroll: the terminal keeps its scrollback, its
    // wheel and its drag-selection. Owning the scroll means asking for mouse
    // reporting, and asking for mouse reporting is exactly what stops a
    // terminal drag-selecting text. These guard the property, not the
    // implementation.
    const appSource = readFileSync(join(import.meta.dir, "..", "src", "interactive", "app.ts"), "utf8");
    const inputSource = readFileSync(join(import.meta.dir, "..", "src", "interactive", "input-handler.ts"), "utf8");

    test("the app never asks the terminal for mouse reporting", () => {
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
    // The differential renderer lives in tui-main-screen.ts since the pi-mono
    // restructure; tui.ts is now the interfaces, Container and TuiBase.
    const tuiSource = readFileSync(join(import.meta.dir, "..", "..", "tui", "src", "tui-main-screen.ts"), "utf8");
    const tuiBaseSource = readFileSync(join(import.meta.dir, "..", "..", "tui", "src", "tui.ts"), "utf8");

    test("no command patches the layout on its way out any more", () => {
        // v0.19.5 fixed /settings alone by repainting on close, which cleared
        // the scrollback to do it (measured: two ESC[3J per toggle).
        expect(settings).not.toContain("repaintOnClose");
    });

    test("the fix lives in the renderer, so every selector gets it", () => {
        expect(tuiSource).toContain("newLines.length < this.previousLines.length");
    });

    test("a rebuilt transcript tells the renderer, instead of being detected", () => {
        // /new, /clear, a mode switch: the new transcript shares no lines with
        // the old one, so diffing them by index compares unrelated rows and
        // concludes the top of the screen is fine — leaving the previous
        // conversation sitting there under a fresh prompt. It cannot be
        // detected either, because a line INSERTED above the window looks
        // identical from the renderer's side and must NOT clear the screen.
        // Only the caller knows which it did.
        const chatHistory = readFileSync(
            join(import.meta.dir, "..", "src", "interactive", "components", "chat-history.ts"),
            "utf8",
        );
        const reset = chatHistory.slice(chatHistory.indexOf("    reset(): void {"));
        expect(reset.slice(0, 700)).toContain("this.tui.resetFrame()");
        expect(tuiBaseSource).toContain("resetFrame(): void {");
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

    test("the nav window fills the screen exactly", () => {
        const h = history(60);
        h.setReserveRows(() => 8);
        h.setViewport(true);
        expect(lines(h).length + 8).toBe(ROWS);
    });
});
