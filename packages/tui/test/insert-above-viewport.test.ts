import { describe, expect, test } from "bun:test";
import { type Component, type TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";
import { TuiMainScreen } from "../src/tui-main-screen";

const COLS = 40;
const ROWS = 10;

/** A frame whose lines the test drives directly. */
class Frame implements Component {
    constructor(public lines: string[]) {}
    render(): string[] {
        return this.lines;
    }
    invalidate(): void {}
}

/** VirtualTerminal that also keeps what was written to it. */
class RecordingTerminal extends VirtualTerminal {
    written = "";
    override write(data: string): void {
        this.written += data;
        super.write(data);
    }
}

function transcript(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `line ${i}`);
}

async function setup(lines: string[]): Promise<{ tui: TUI; term: RecordingTerminal; frame: Frame }> {
    const term = new RecordingTerminal(COLS, ROWS);
    const tui = new TuiMainScreen(term);
    const frame = new Frame(lines);
    tui.addChild(frame);
    tui.start();
    await term.waitForRender();
    return { tui, term, frame };
}

describe("content inserted above the visible window", () => {
    // A late startup notice (MCP connecting, the hooks list arriving after the
    // trust prompt) lands under the banner, which on a resumed session has long
    // since scrolled off the top. That used to take the whole screen AND the
    // terminal's scrollback with it: ESC[3J on every such line.
    test("does not clear the screen or the scrollback", async () => {
        const { tui, term, frame } = await setup(transcript(40));
        const before = await term.flushAndGetViewport();

        term.written = "";
        frame.lines = ["line 0", "MCP: linear (12)", ...transcript(40).slice(1)];
        tui.requestRender();
        await term.waitForRender();

        expect(term.written).not.toContain("\x1b[3J"); // scrollback
        expect(term.written).not.toContain("\x1b[2J"); // screen
        // The tail of the conversation is still the tail: nothing on screen
        // moved, because nothing on screen had a reason to.
        expect(await term.flushAndGetViewport()).toEqual(before);
        tui.stop();
    });

    test("writes nothing at all when the window's content is untouched", async () => {
        const { tui, term, frame } = await setup(transcript(40));

        term.written = "";
        frame.lines = ["line 0", "hooks (2):", ...transcript(40).slice(1)];
        tui.requestRender();
        await term.waitForRender();

        // Every visible row still says exactly what it said, so the correct
        // amount of output is none — only loop's line bookkeeping moved.
        expect(term.written.replace(/\x1b\[\?25[lh]/g, "")).toBe("");
        tui.stop();
    });

    test("still repaints the window when the visible rows really changed", async () => {
        const { tui, term, frame } = await setup(transcript(40));

        term.written = "";
        // Inserted above the window AND the last line rewritten.
        const next = ["line 0", "MCP: linear (12)", ...transcript(40).slice(1)];
        next[next.length - 1] = "line 39 (changed)";
        frame.lines = next;
        tui.requestRender();
        await term.waitForRender();

        expect(term.written).not.toContain("\x1b[3J");
        const viewport = await term.flushAndGetViewport();
        expect(viewport[viewport.length - 1].trim()).toBe("line 39 (changed)");
        // And the rest of the window is the tail of the new frame.
        expect(viewport[viewport.length - 2].trim()).toBe("line 38");
        tui.stop();
    });

    test("a short frame is untouched by any of this", async () => {
        // Nothing has scrolled off, so the ordinary differential path still
        // owns it — the fast path must not claim a window loop never painted.
        const { tui, term, frame } = await setup(["a", "b", "c"]);
        frame.lines = ["a", "inserted", "b", "c"];
        tui.requestRender();
        await term.waitForRender();
        const viewport = await term.flushAndGetViewport();
        expect(viewport.slice(0, 4).map((l) => l.trim())).toEqual(["a", "inserted", "b", "c"]);
        tui.stop();
    });
});
