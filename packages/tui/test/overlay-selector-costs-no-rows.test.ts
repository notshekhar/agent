import assert from "node:assert";
import { describe, it } from "bun:test";
import { type Component, Container, type TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";
import { TuiMainScreen } from "../src/tui-main-screen";

/**
 * A selector painted over the frame costs the frame no rows.
 *
 * Swapping one in for the editor is what used to make the frame taller, and a
 * frame that fills the screen answers that by scrolling — which commits the
 * rows at the top to the scrollback, where they cannot be taken back. Closing
 * it shortens the frame again, those rows cannot come home, and the prompt is
 * left above a blank band the height of the menu that just closed.
 *
 * These tests hold the property that makes the band impossible rather than
 * survivable: while the selector is up, the frame is exactly as long as it was
 * without it.
 */
class Lines implements Component {
    constructor(public lines: string[]) {}
    render(): string[] {
        return this.lines;
    }
    invalidate(): void {}
}

/** The app's shape: transcript, editor, status line, trailing spacer. */
function app(height: number): {
    terminal: VirtualTerminal;
    tui: TUI;
    chat: Lines;
    editorSlot: Container;
    editor: Lines;
    paint: () => Promise<void>;
    viewport: () => string[];
} {
    const terminal = new VirtualTerminal(40, height);
    const tui = new TuiMainScreen(terminal);
    const chat = new Lines(Array.from({ length: height * 2 }, (_, i) => `chat ${i}`));
    const editor = new Lines(["> prompt"]);
    const editorSlot = new Container();
    editorSlot.addChild(editor);
    const root = new Container();
    root.addChild(chat);
    root.addChild(editorSlot);
    root.addChild(new Lines(["status line"]));
    root.addChild(new Lines([""]));
    tui.addChild(root);
    return {
        terminal,
        tui,
        chat,
        editorSlot,
        editor,
        paint: async () => {
            tui.requestRender();
            await terminal.waitForRender();
        },
        viewport: () => terminal.getViewport().map((line) => line.trimEnd()),
    };
}

/** What showSelector passes for a frame that fills the screen. */
const SELECTOR_OPTIONS = {
    width: "100%",
    maxHeight: "100%",
    anchor: "bottom-left",
    margin: { bottom: 2 },
    nonCapturing: true,
} as const;

describe("a selector painted over the frame", () => {
    it("leaves the frame's length alone, so nothing scrolls and no band opens", async () => {
        const a = app(14);
        a.tui.start();
        await a.paint();

        const before = a.viewport();
        const committedBefore = a.terminal.getScrollBuffer().length;

        const menu = new Lines(["menu a", "menu b", "menu c", "menu d", "menu e", "menu f"]);
        const overlay = a.tui.showOverlay(menu, SELECTOR_OPTIONS);
        await a.paint();

        // The menu sits where the editor was, with the status line still under
        // it, and the transcript above has not moved a row.
        const open = a.viewport();
        assert.strictEqual(open[13], "");
        assert.strictEqual(open[12], "status line");
        assert.strictEqual(open[11], "menu f");
        assert.strictEqual(open[6], "menu a");
        assert.deepStrictEqual(open.slice(0, 6), before.slice(0, 6), "the transcript above did not move");
        assert.strictEqual(
            a.terminal.getScrollBuffer().length,
            committedBefore,
            "nothing was pushed into the scrollback to make room",
        );

        overlay.hide();
        await a.paint();

        // ...and closing it puts the screen back exactly as it was. No band.
        assert.deepStrictEqual(a.viewport(), before, "the screen came back unchanged");
        a.tui.stop();
    });

    it("covers the editor even when the menu is shorter than it", async () => {
        const a = app(14);
        a.editor.lines = ["", "> a draft", "  spanning", "  four rows"];
        a.tui.start();
        await a.paint();

        // The wrapper showSelector uses: never shorter than the editor block.
        const menu = new Lines(["yes", "no"]);
        const covering: Component = {
            render: (width: number) => {
                const lines = menu.render(width);
                const min = a.editorSlot.render(width).length;
                return lines.length >= min ? lines : [...new Array<string>(min - lines.length).fill(""), ...lines];
            },
            invalidate: () => {},
        };
        const overlay = a.tui.showOverlay(covering, SELECTOR_OPTIONS);
        await a.paint();

        const open = a.viewport();
        assert.ok(
            !open.some((line) => line.includes("a draft") || line.includes("four rows")),
            `no part of the editor shows through: ${JSON.stringify(open)}`,
        );
        assert.strictEqual(open[11], "no");
        assert.strictEqual(open[12], "status line");

        overlay.hide();
        await a.paint();
        assert.ok(
            a.viewport().some((line) => line.includes("a draft")),
            "the draft comes back",
        );
        a.tui.stop();
    });

    it("costs the frame nothing while it is registered but not visible", async () => {
        // The completion list is held open for the whole session and gated on
        // `visible`, because it comes and goes on nearly every keystroke. On
        // the frames it is down it must not shape the frame at all — including
        // the pad-to-terminal-height that compositing does, which would turn
        // every short unpinned transcript into a padded one.
        const a = app(14);
        a.chat.lines = ["chat 0", "chat 1"];
        a.tui.start();
        await a.paint();
        const short = a.viewport();
        assert.strictEqual(short[4], "", "a short frame does not reach the bottom rows");

        let showing = false;
        const popup = new Lines(["completion a", "completion b"]);
        a.tui.showOverlay(popup, { ...SELECTOR_OPTIONS, visible: () => showing });
        await a.paint();
        assert.deepStrictEqual(a.viewport(), short, "registering it changed nothing");

        showing = true;
        await a.paint();
        assert.ok(
            a.viewport().some((line) => line === "completion b"),
            "and it draws when it says it is visible",
        );

        showing = false;
        await a.paint();
        assert.deepStrictEqual(a.viewport(), short, "and gets out of the way again");
        a.tui.stop();
    });

    it("does not grow the frame even when the menu is taller than the screen", async () => {
        const a = app(12);
        a.tui.start();
        await a.paint();
        const committedBefore = a.terminal.getScrollBuffer().length;

        const menu = new Lines(Array.from({ length: 40 }, (_, i) => `item ${i}`));
        const overlay = a.tui.showOverlay(menu, SELECTOR_OPTIONS);
        await a.paint();

        assert.strictEqual(
            a.terminal.getScrollBuffer().length,
            committedBefore,
            "an oversized menu is clipped, not paid for in scrollback",
        );
        const open = a.viewport();
        assert.strictEqual(open[11], "");
        assert.strictEqual(open[10], "status line");

        overlay.hide();
        await a.paint();
        assert.ok(
            a.viewport().some((line) => line.includes("> prompt")),
            "the prompt is back",
        );
        a.tui.stop();
    });
});
