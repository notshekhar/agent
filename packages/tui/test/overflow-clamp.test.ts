import assert from "node:assert";
import { describe, it } from "bun:test";
import { type Component, type TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";
import { TuiMainScreen } from "../src/tui-main-screen";

class TestComponent implements Component {
    lines: string[] = [];
    render(_width: number): string[] {
        return this.lines;
    }
    invalidate(): void {}
}

describe("over-wide line clamping", () => {
    it("clamps an over-wide line and keeps the UI alive (no crash-stop)", async () => {
        const terminal = new VirtualTerminal(20, 6);
        const tui = new TuiMainScreen(terminal);
        const component = new TestComponent();
        tui.addChild(component);

        // 30 visible cols on a 20-col terminal — the old guard stopped the
        // TUI and threw, leaving a dead screen that echoed typed keys below
        // the last frame.
        component.lines = ["X".repeat(30)];
        tui.start();
        await terminal.waitForRender();

        // Still running: a later render must go through and show new content.
        component.lines = ["after"];
        tui.requestRender();
        await terminal.waitForRender();
        const screen = terminal.getViewport().join("\n");
        assert.ok(screen.includes("after"), `expected follow-up render, got:\n${screen}`);

        tui.stop();
    });
});
