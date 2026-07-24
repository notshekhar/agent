/**
 * The builtin `noir` UI mode — a dark-canvas experience in the spirit of
 * terminal cockpits: OSC 11 background wash, one-line diamond tool rows that
 * grey out when folded, thinking as its own block that streams a short tail
 * and collapses when the turn moves on, `❯` user prompts, and a turn summary
 * line. Built strictly on the public mode contract (style spec + themes +
 * block renderers) — if this file needs private hooks, the contract is wrong.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@notshekhar/loop-tui";
import type { ThemeJson } from "./themes";
import { readGutterPrefixes, readLineRangeText } from "./tool-summary";
import {
    registerUiMode,
    uiStyle,
    type RenderCtx,
    type ThinkingBlockState,
    type ToolBlockState,
    type UiModePlugin,
} from "./ui-mode";

export const NIGHT_THEME: ThemeJson = {
    name: "night",
    vars: {
        bgBase: "#141414",
        bgRaised: "#242424",
        magenta: "#c678dd",
        blue: "#61afef",
        cyan: "#56b6c2",
        green: "#98c379",
        red: "#e06c75",
        yellow: "#e5c07b",
        text: "#e0e0e0",
        gray: "#8a8a8a",
        dimGray: "#5f5f5f",
        darkGray: "#3a3a3a",
        flatBox: "#1b1b1b",
    },
    colors: {
        accent: "magenta",
        border: "darkGray",
        borderAccent: "magenta",
        borderMuted: "darkGray",
        success: "green",
        error: "red",
        warning: "yellow",
        muted: "gray",
        dim: "dimGray",
        text: "text",
        thinkingText: "gray",
        selectedBg: "#2c2c38",
        userMessageBg: "bgRaised",
        userMessageText: "text",
        customMessageBg: "#241d2e",
        customMessageText: "text",
        customMessageLabel: "#b294bb",
        toolPendingBg: "flatBox",
        toolSuccessBg: "flatBox",
        toolErrorBg: "#251717",
        toolTitle: "text",
        toolOutput: "gray",
        toolError: "#ff6b6b",
        mdHeading: "yellow",
        mdLink: "blue",
        mdLinkUrl: "dimGray",
        mdCode: "magenta",
        mdCodeBlock: "green",
        mdCodeBlockBorder: "gray",
        mdQuote: "gray",
        mdQuoteBorder: "gray",
        mdHr: "darkGray",
        mdListBullet: "magenta",
        toolDiffAdded: "green",
        toolDiffRemoved: "red",
        toolDiffContext: "gray",
        syntaxComment: "#6A9955",
        syntaxKeyword: "#569CD6",
        syntaxFunction: "#DCDCAA",
        syntaxVariable: "#9CDCFE",
        syntaxString: "#CE9178",
        syntaxNumber: "#B5CEA8",
        syntaxType: "#4EC9B0",
        syntaxOperator: "#D4D4D4",
        syntaxPunctuation: "#D4D4D4",
        thinkingOff: "darkGray",
        thinkingMinimal: "#6e6e6e",
        thinkingLow: "#5f87af",
        thinkingMedium: "#81a2be",
        thinkingHigh: "#b294bb",
        thinkingXhigh: "#d183e8",
        bashMode: "green",
        bgBase: "bgBase",
        bgRaised: "bgRaised",
        accentUser: "magenta",
        accentAssistant: "text",
        accentThinking: "gray",
        accentTool: "dimGray",
        timestamp: "dimGray",
        selectionBorder: "magenta",
        turnSummary: "dimGray",
    },
};

export const DAY_THEME: ThemeJson = {
    name: "day",
    vars: {
        bgBase: "#f4f4f5",
        bgRaised: "#e2e2e6",
        magenta: "#7c3aed",
        blue: "#1d4ed8",
        green: "#15803d",
        red: "#dc2626",
        yellow: "#a16207",
        text: "#18181b",
        gray: "#4b4b52",
        dimGray: "#6e6e76",
        lightGray: "#b4b4ba",
        flatBox: "#e9e9eb",
    },
    colors: {
        accent: "magenta",
        border: "lightGray",
        borderAccent: "magenta",
        borderMuted: "lightGray",
        success: "green",
        error: "red",
        warning: "yellow",
        muted: "gray",
        dim: "dimGray",
        text: "text",
        thinkingText: "gray",
        selectedBg: "#dcdce6",
        userMessageBg: "bgRaised",
        userMessageText: "text",
        customMessageBg: "#ede7f6",
        customMessageText: "text",
        customMessageLabel: "#7e57c2",
        toolPendingBg: "flatBox",
        toolSuccessBg: "flatBox",
        toolErrorBg: "#f6e4e4",
        toolTitle: "text",
        toolOutput: "gray",
        toolError: "#c62828",
        mdHeading: "yellow",
        mdLink: "blue",
        mdLinkUrl: "dimGray",
        mdCode: "magenta",
        mdCodeBlock: "green",
        mdCodeBlockBorder: "gray",
        mdQuote: "gray",
        mdQuoteBorder: "gray",
        mdHr: "lightGray",
        mdListBullet: "magenta",
        toolDiffAdded: "green",
        toolDiffRemoved: "red",
        toolDiffContext: "gray",
        syntaxComment: "#008000",
        syntaxKeyword: "#0000FF",
        syntaxFunction: "#795E26",
        syntaxVariable: "#001080",
        syntaxString: "#A31515",
        syntaxNumber: "#098658",
        syntaxType: "#267F99",
        syntaxOperator: "#000000",
        syntaxPunctuation: "#000000",
        thinkingOff: "lightGray",
        thinkingMinimal: "#767676",
        thinkingLow: "blue",
        thinkingMedium: "#4078f2",
        thinkingHigh: "#875f87",
        thinkingXhigh: "#8b008b",
        bashMode: "green",
        bgBase: "bgBase",
        bgRaised: "bgRaised",
        accentUser: "magenta",
        accentAssistant: "text",
        accentThinking: "gray",
        accentTool: "dimGray",
        timestamp: "dimGray",
        selectionBorder: "magenta",
        turnSummary: "dimGray",
    },
};

/** One-line rows must never exceed the terminal width — an overflowing line
 * trips the TUI's crash guard and kills the whole UI (a long bash command in
 * a tool header did exactly that). Truncate with an ellipsis, grok-style. */
function fitRow(line: string, width: number): string {
    return visibleWidth(line) > width ? truncateToWidth(line, Math.max(0, width - 1)) + "…" : line;
}

/** `0.5s` under 10s, `41s` under a minute, `1m23s` beyond. Branch on the
 * ROUNDED value — branching on the raw one printed "60s" and "1m00s" for
 * 119.7s (minutes floored raw, seconds rounded up past the boundary). */
function fmtSeconds(ms: number): string {
    const s = Math.max(0, ms) / 1000;
    const tenth = Math.round(s * 10) / 10;
    if (tenth < 10) return `${tenth.toFixed(1)}s`;
    const r = Math.round(s);
    if (r < 60) return `${r}s`;
    return `${Math.floor(r / 60)}m${String(r % 60).padStart(2, "0")}s`;
}

/**
 * Thinking as a foldable one-line row, grok-style: `◆ Thought for 0.5s`
 * once done, a dim header + accent gutter + short tail while streaming,
 * the full gutter body when expanded (nav per-entry → or expand-all).
 */
function renderThinking(state: ThinkingBlockState, ctx: RenderCtx): string[] {
    const th = ctx.theme;
    const label =
        state.durationMs !== undefined
            ? `Thought for ${fmtSeconds(state.durationMs)}`
            : state.streaming
              ? "Thinking…"
              : "Thought";
    const header = fitRow("  " + th.fg("accentThinking", th.italic(`◆ ${label}`)), ctx.width);
    // Every block owns exactly ONE leading blank (layout.blockGaps) — same
    // deterministic gap whether the transcript streamed live or replayed.
    if (!state.streaming && !state.expanded) {
        return [
            "",
            fitRow(
                header + (state.selected ? th.fg("dim", ` (${uiStyle().hints.selectedExpandHint} to expand)`) : ""),
                ctx.width,
            ),
        ];
    }
    const gutter = " " + th.fg("accentThinking", "┃") + " ";
    const wrapped = state.text
        .split("\n")
        .flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(20, ctx.width - 4)) : [""]));
    const body = state.streaming && !state.expanded ? wrapped.slice(-uiStyle().thinking.liveTailLines) : wrapped;
    return ["", header, ...body.map((l) => gutter + th.fg("thinkingText", th.italic(l)))];
}

/**
 * Tools as flat one-line rows: `◆ name summary` — no box, no background.
 * Muted once done+folded, theme text when selected, error red on failure.
 * Expanded rows show the output under an accent gutter. The
 * plan tool keeps its default box look (an approval surface the user must
 * read), so this returns null for it.
 *
 * Subagents (task) are the same row shape: `◆ task <agent> · <status>` with
 * the live activity tail while running and the full run log when expanded.
 * The subagent's own turns/parts render as lines of that log — per-part
 * folding inside a subagent needs nested entries (the pager phase).
 */
function renderTool(state: ToolBlockState, ctx: RenderCtx): string[] | null {
    if (state.toolName === "plan") return null;
    const isTask = state.toolName === "task";
    const th = ctx.theme;
    const bodyWidth = Math.max(20, ctx.width - 4);
    const gutter = " " + th.fg("accentTool", "┃") + " ";

    // The diamond carries the state (grok's accent_running/success/error):
    // yellow while running, green on success, red on failure. The title text
    // stays muted once done (bright while running or selected).
    const failed = state.isError && !state.isPartial;
    const diamond = th.fg(
        failed ? "toolError" : state.interrupted ? "muted" : state.isPartial ? "warning" : "success",
        "◆",
    );
    const titleColor = failed ? "toolError" : state.isPartial || state.selected ? "text" : "muted";

    let name = state.toolName;
    let detail = state.summary ? " " + th.fg("muted", state.summary) : "";
    // `read src/app.ts:120-180` — the offset/limit range rides the row the way
    // the default box shows it (dim here, since noir's details are dim). Modes
    // only get `summary`, which is the path alone, so without this an offset
    // read is indistinguishable from a whole-file one.
    if (state.toolName === "read") {
        const range = readLineRangeText(state.args);
        if (range) detail += th.fg("dim", range);
    }
    if (isTask) {
        // `task <agent> · <live status | done · stats> · <prompt snippet>` —
        // the same identity line the default box shows, as a grok row.
        const agent = typeof state.args.agent === "string" ? state.args.agent : "default";
        const snippet = typeof state.args.prompt === "string" ? state.args.prompt.split("\n")[0].slice(0, 50) : "";
        const stats = state.taskStats;
        const doneParts = [
            "done",
            ...(stats?.steps ? [`${stats.steps} step${stats.steps === 1 ? "" : "s"}`] : []),
            ...(stats?.durationMs !== undefined ? [fmtSeconds(stats.durationMs)] : []),
            ...(stats?.usd !== undefined ? [`$${stats.usd.toFixed(4)}`] : []),
        ];
        const status = state.isPartial
            ? state.statusText || "running"
            : state.interrupted
              ? "interrupted"
              : failed
                ? "failed"
                : doneParts.join(" · ");
        name = `task ${agent}`;
        detail = " " + th.fg("muted", snippet ? `${status} · ${snippet}` : status);
    }
    const status = !isTask
        ? state.isPartial
            ? th.fg("dim", ` · ${state.statusText || "running"}`)
            : state.interrupted
              ? th.fg("dim", " · interrupted")
              : ""
        : "";
    const header = fitRow("  " + diamond + " " + th.fg(titleColor, th.bold(name)) + detail + status, ctx.width);

    const lines = state.groupLead ? ["", header] : [header];

    // Subagent body: the live activity tail while running; the full run log
    // when expanded. Each subagent turn/part is one log line.
    if (isTask) {
        if (!state.output) return lines;
        const raw = state.output.split("\n");
        if (state.isPartial) {
            const tail = raw.slice(-uiStyle().thinking.liveTailLines);
            for (const l of tail.flatMap((x) => (x ? wrapTextWithAnsi(x, bodyWidth) : [""]))) {
                lines.push(gutter + th.fg("toolOutput", l));
            }
            return lines;
        }
        if (!state.expanded) {
            if (state.selected) {
                lines[0] = fitRow(
                    lines[0] + th.fg("dim", ` (${uiStyle().hints.selectedExpandHint} to expand)`),
                    ctx.width,
                );
            }
            return lines;
        }
        for (const rawLine of raw) {
            for (const l of rawLine ? wrapTextWithAnsi(rawLine, bodyWidth) : [""]) {
                lines.push(gutter + th.fg(state.isError ? "toolError" : "toolOutput", l));
            }
        }
        return lines;
    }

    // Streaming input (write/edit content) — live tail while the args arrive.
    if (state.isPartial && state.streamingContent && !state.output) {
        const tail = state.streamingContent.split("\n").slice(-uiStyle().thinking.liveTailLines);
        for (const l of tail.flatMap((x) => wrapTextWithAnsi(x, bodyWidth))) {
            lines.push(gutter + th.fg("toolOutput", l));
        }
        return lines;
    }

    // Output: hidden while folded (grok's whole point), shown expanded.
    // Failures fold too — the red diamond + title carry the signal; expand
    // (nav →) to read the error.
    if (!state.output || !state.expanded) {
        if (state.output && state.selected) {
            lines[0] = fitRow(lines[0] + th.fg("dim", ` (${uiStyle().hints.selectedExpandHint} to expand)`), ctx.width);
        }
        return lines;
    }
    const color = state.isError ? "toolError" : "toolOutput";
    const rawLines = state.output.split("\n");
    // `read` bodies carry absolute line numbers; every other tool's output is
    // its own text and gets none.
    const gutters =
        state.toolName === "read" && !state.isError ? readGutterPrefixes(rawLines, state.args) : rawLines.map(() => "");
    for (const [i, raw] of rawLines.entries()) {
        const num = gutters[i];
        // Only the first visual row of a wrapped source line is numbered; its
        // continuations are indented to stay under the same column.
        const numWidth = num.length;
        let first = true;
        for (const l of raw ? wrapTextWithAnsi(raw, Math.max(20, bodyWidth - numWidth)) : [""]) {
            const prefix = num ? (first ? th.fg("dim", num) : " ".repeat(numWidth)) : "";
            first = false;
            const diff =
                !state.isError && (state.toolName === "edit" || state.toolName === "write")
                    ? l.startsWith("+")
                        ? th.fg("toolDiffAdded", l)
                        : l.startsWith("-")
                          ? th.fg("toolDiffRemoved", l)
                          : th.fg("toolDiffContext", l)
                    : th.fg(color, l);
            lines.push(gutter + prefix + diff);
        }
    }
    return lines;
}

const NOIR_MODE: UiModePlugin = {
    id: "noir",
    name: "Noir",
    themes: [NIGHT_THEME, DAY_THEME],
    style: {
        canvas: { wash: true },
        thinking: { display: "block", liveTailLines: 3, collapseOnFinish: true, gutter: true },
        tool: { bullet: "◆", mutedCollapsed: true },
        userMessage: { prefix: "❯", timestamp: true },
        turn: { summaryLine: true },
        layout: { blockGaps: true },
    },
    render: { thinking: renderThinking, toolExecution: renderTool },
};

export function registerNoirMode(): void {
    registerUiMode(NOIR_MODE);
}
