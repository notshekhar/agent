/**
 * The builtin `live` UI mode — loop's cockpit view, toggled with ctrl+e.
 *
 * Where `noir` is a transcript that scrolls the terminal, `live` is a fixed
 * frame: the prompt is pinned to the bottom of the screen and the transcript
 * scrolls in a viewport above it, so the thing you type into never walks off
 * the top and the thing you're watching never jumps. It is the mode to sit in
 * while an agent works.
 *
 * Two behaviours are its own, on top of noir's look (which it reuses wholesale
 * — same rails, same diamonds, same wave):
 *
 * 1. **Pinned input** — while live mode is active the transcript renders into
 *    a window (the nav viewport), so the prompt holds its place instead of
 *    being pushed down the screen.
 * 2. **Tool grouping** (`tool.group`) — a run of finished, folded tool rows
 *    collapses into one aggregated header (`Read 3 files`), grok-style. That
 *    makes the transcript a two-level fold: open the group to see its calls,
 *    open a call to see its output.
 *
 * It deliberately does NOT define its own palette. A mode you flip in and out
 * of mid-turn must not restyle the whole screen underneath you — the canvas
 * should look identical either side of the toggle, with only the frame and the
 * folds changing.
 */
import { DAY_THEME, NIGHT_THEME, renderThinking, renderTool } from "./noir-mode";
import { registerUiMode, type UiModePlugin } from "./ui-mode";

export const LIVE_MODE_ID = "live";

const LIVE_MODE: UiModePlugin = {
    id: LIVE_MODE_ID,
    name: "Live",
    themes: [NIGHT_THEME, DAY_THEME],
    style: {
        canvas: { wash: true },
        thinking: { display: "block", liveTailLines: 3, collapseOnFinish: true, gutter: true },
        tool: { bullet: "◆", mutedCollapsed: true, group: true },
        userMessage: { prefix: "❯", timestamp: true },
        turn: { summaryLine: true },
        layout: { blockGaps: true },
        // Inside live mode the transcript already has the keyboard, so the
        // route to hidden content is just the arrow — no "ctrl+e first".
        hints: { expandHint: "→", selectedExpandHint: "→" },
    },
    render: { thinking: renderThinking, toolExecution: renderTool },
};

export function registerLiveMode(): void {
    registerUiMode(LIVE_MODE);
}
