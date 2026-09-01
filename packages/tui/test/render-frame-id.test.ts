import { describe, expect, test } from "bun:test";
import { type Component, type TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";
import { TuiMainScreen } from "../src/tui-main-screen";

/**
 * The frame identity a component can memoize one frame's worth of measurement
 * against — the pinned prompt's reserve-rows measurement is the caller this
 * exists for. What the memo needs is exactly two guarantees: the id changes
 * per frame, and it is only usable while a frame is being composed.
 */
class Probe implements Component {
    seen: Array<{ frame: number; rendering: boolean }> = [];

    constructor(private tui: TUI) {}

    render(): string[] {
        this.seen.push({ frame: this.tui.renderFrameId, rendering: this.tui.isRendering() });
        return ["probe"];
    }
    invalidate(): void {}
}

describe("render frame identity", () => {
    test("the id advances once per frame and is only live during one", async () => {
        const terminal = new VirtualTerminal(80, 24);
        const tui = new TuiMainScreen(terminal);
        const probe = new Probe(tui);
        tui.addChild(probe);

        expect(tui.isRendering()).toBe(false);

        tui.start();
        await terminal.waitForRender();
        const first = probe.seen.at(-1);
        expect(first?.rendering).toBe(true);

        tui.requestRender(true);
        await terminal.waitForRender();
        const second = probe.seen.at(-1);
        expect(second?.rendering).toBe(true);
        expect(second!.frame).toBeGreaterThan(first!.frame);

        // Between frames the id is stale by definition, and says so.
        expect(tui.isRendering()).toBe(false);
        tui.stop();
    });
});
