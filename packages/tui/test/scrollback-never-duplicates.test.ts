import assert from "node:assert";
import { describe, it } from "bun:test";
import { type Component, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * A line that has scrolled off the top of the terminal is committed: it cannot
 * be moved, only printed a second time. So no frame the renderer paints may put
 * one back on the screen — the copy already in the history stays where it is,
 * and the transcript then reads the conversation twice.
 *
 * This is the bug reported against v0.19.8: a turn full of collapsing tool
 * groups left whole stretches of the chat duplicated in the scrollback, in
 * order, so scrolling back replayed the session.
 */
class Frame implements Component {
    lines: string[] = [];
    render(): string[] {
        return this.lines;
    }
    invalidate(): void {}
}

/** Every line the terminal holds: scrollback plus the visible window. */
function printedLines(terminal: VirtualTerminal): string[] {
    return terminal
        .getScrollBuffer()
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
}

function duplicates(terminal: VirtualTerminal, prefix: string): string[] {
    const counts = new Map<string, number>();
    for (const line of printedLines(terminal)) {
        if (!line.startsWith(prefix)) continue;
        counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([line, n]) => `${line} x${n}`);
}

describe("a committed line is never printed twice", () => {
    it("a frame that shrinks does not reprint the rows above the window", async () => {
        const height = 20;
        const terminal = new VirtualTerminal(60, height);
        const tui = new TUI(terminal);
        const frame = new Frame();
        tui.addChild(frame);

        const chat: string[] = [];
        let editor = ["", "> prompt", ""];
        const paint = async (): Promise<void> => {
            frame.lines = [...chat, ...editor];
            tui.requestRender();
            await terminal.waitForRender();
        };

        tui.start();
        for (let i = 0; i < 8; i++) chat.push(`chat ${i}`);
        await paint();

        // Grow well past the bottom of the screen, so there is a scrollback to
        // duplicate into.
        for (let i = 8; i < 60; i++) {
            chat.push(`chat ${i}`);
            await paint();
        }
        assert.deepStrictEqual(duplicates(terminal, "chat"), [], "appending must not duplicate");

        // The editor collapses back to a single line — the everyday shrink.
        editor = ["> prompt"];
        await paint();
        assert.deepStrictEqual(duplicates(terminal, "chat"), [], "a shrink must not duplicate");

        // ...and grows again.
        editor = ["", "> prompt", ""];
        await paint();
        assert.deepStrictEqual(duplicates(terminal, "chat"), [], "regrowing must not duplicate");

        tui.stop();
    });

    it("a turn of collapsing tool groups leaves one copy of the chat", async () => {
        const height = 20;
        const terminal = new VirtualTerminal(60, height);
        const tui = new TUI(terminal);
        const frame = new Frame();
        tui.addChild(frame);

        const chat: string[] = [];
        let live: string[] = [];
        const editor = ["", "> prompt", ""];
        const paint = async (): Promise<void> => {
            frame.lines = [...chat, ...live, ...editor];
            tui.requestRender();
            await terminal.waitForRender();
        };

        tui.start();
        for (let i = 0; i < 10; i++) chat.push(`chat ${i}`);
        await paint();

        // Three tool calls: each streams eight rows and then collapses to one —
        // a seven-row shrink, each asking for seven committed rows back.
        let n = 10;
        for (let call = 0; call < 3; call++) {
            live = [];
            for (let i = 0; i < 8; i++) {
                live.push(`tool output ${n++}`);
                await paint();
            }
            live = [];
            chat.push(`chat called tool ${call}`);
            await paint();
            for (let i = 0; i < 4; i++) {
                chat.push(`chat ${n++}`);
                await paint();
            }
        }

        assert.deepStrictEqual(duplicates(terminal, "chat"), [], "the transcript must read once");

        // And what is in the history is in the order it was written.
        const printed = printedLines(terminal).filter((line) => line.startsWith("chat "));
        const expected = chat.filter((line) => printed.includes(line));
        assert.deepStrictEqual(printed, expected, "committed lines stay in order");

        tui.stop();
    });
});
