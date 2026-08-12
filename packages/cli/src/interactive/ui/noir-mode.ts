/**
 * The builtin `noir` UI mode — a dark-canvas experience in the spirit of
 * terminal cockpits: OSC 11 background wash, one-line diamond tool rows that
 * grey out when folded, thinking as its own block that streams a short tail
 * and collapses when the turn moves on, `❯` user prompts, and a turn summary
 * line. Built strictly on the public mode contract (style spec + themes +
 * block renderers) — if this file needs private hooks, the contract is wrong.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@notshekhar/loop-tui";
import { DARK_INK, LIGHT_INK, type Palette, type ThemeJson, themeFromPalette } from "./palette";
import { bulletColor, RAIL_WIDTH, railForState, withRail, type RailSpec } from "./rail";
import { fgHex, type ThemeBg, type ThemeColor } from "./theme";
import { readGutterPrefixes, readLineRangeText } from "./tool-summary";
import {
    registerUiMode,
    uiStyle,
    type RenderCtx,
    type ThinkingBlockState,
    type ToolBlockState,
    type UiModePlugin,
} from "./ui-mode";

/**
 * Noir's palettes. Unlike `loop` mode it washes the canvas, so the terminal
 * background IS the desktop's `--background` and the surface levels can sit as
 * close together as they do in the desktop app. See `palette.ts` for how the
 * theme slots are derived from these primitives.
 */
/**
 * Noir's ink.
 *
 * Loop mode keeps the classic vivid palette, which is right for a mode drawing
 * on whatever background your terminal happens to have. Noir washes its own
 * canvas, so it can afford one deliberate set instead: every colour sits at a
 * single lightness and a shared chroma, with hues spread far enough apart to
 * stay distinguishable. A message renders tonal rather than primary — no
 * colour shouts over its neighbours.
 *
 * Two exceptions carry extra chroma rather than extra brightness, because both
 * have a job beyond looking pleasant: a heading has to lead its section, and an
 * error has to alert. Each hue is still anchored to what it MEANS — success is
 * green, error is red, a number is cool — so the set is normalised, not
 * arbitrary.
 */
const NIGHT_INK = {
    // The brand blue, held at the set's lightness. Full-chroma primary sat
    // outside the family badly: as a list bullet or a prompt it was the one
    // vivid mark on an otherwise tonal screen.
    accent: "#77a0dc",
    heading: "#d5bb7b",
    warning: "#dcb77f",
    error: "#f5a5a7",
    success: "#a0cba5",
    inlineCode: "#d5afd7",
    codeBlock: "#a0cba5",
    accentLift: "#a2c0eb",
    thinkingPeak: "#beb6e8",
    syntax: {
        comment: "#6f6f6f",
        keyword: "#e6a9c5",
        function: "#beb6e8",
        variable: "#e2b293",
        string: "#a0cba5",
        number: "#87cbd5",
        type: "#d5afd7",
        operator: "#8a8a8a",
        punctuation: "#8a8a8a",
    },
} as const;

const DAY_INK = {
    accent: "#3463a6",
    heading: "#7c5f00",
    warning: "#835b06",
    error: "#9a444a",
    success: "#3f7047",
    inlineCode: "#7c527e",
    codeBlock: "#3f7047",
    accentLift: "#446493",
    thinkingPeak: "#645a90",
    syntax: {
        comment: "#767676",
        keyword: "#8c4a6b",
        function: "#645a90",
        variable: "#885531",
        string: "#3f7047",
        number: "#04707c",
        type: "#7c527e",
        operator: "#6b6b6b",
        punctuation: "#6b6b6b",
    },
} as const;

export const NIGHT_PALETTE: Palette = {
    ...DARK_INK,
    ...NIGHT_INK,
    name: "night",
    wash: true,
    bg: "#141414",
    bgRaised: "#1f1f21",
    bgSunken: "#1a1a1c",
    line: "#33333a",
    toolSurfaces: "flat",
};

export const DAY_PALETTE: Palette = {
    ...LIGHT_INK,
    ...DAY_INK,
    name: "day",
    wash: true,
    bg: "#fcfcfc",
    bgRaised: "#f1f1f3",
    bgSunken: "#f7f7f8",
    line: "#d6d6dd",
    toolSurfaces: "flat",
};

export const NIGHT_THEME: ThemeJson = themeFromPalette(NIGHT_PALETTE);
export const DAY_THEME: ThemeJson = themeFromPalette(DAY_PALETTE);

/** One-line rows must never exceed the terminal width — an overflowing line
 * trips the TUI's crash guard and kills the whole UI (a long bash command in
 * a tool header did exactly that). Truncate with an ellipsis, grok-style. */
function fitRow(line: string, width: number): string {
    return visibleWidth(line) > width ? truncateToWidth(line, Math.max(0, width - 1)) + "…" : line;
}

/**
 * A theme slot's hex, for the uses that need a real colour to blend rather
 * than an SGR escape (the rail's wave, the bullet's pulse).
 *
 * Themes may carry 256-indexes or the terminal default (`""`) instead of hex —
 * neither can be blended — so those fall back to the caller's colour and the
 * surface renders static. Motion is a nicety; a wrong colour is not.
 */
function hexOf(ctx: RenderCtx, slot: ThemeColor | ThemeBg, fallback: string): string {
    const raw = ctx.theme.raw(slot);
    return typeof raw === "string" && raw.startsWith("#") ? raw : fallback;
}

/**
 * The rail palette for this theme — resolved once per block render.
 *
 * NOT `accentTool`/`accentThinking`: those slots resolve to the palette's
 * `dim`/`muted` greys (they were the old expanded-body gutter colours, meant to
 * recede). A LIVE rail has the opposite job — it is the one thing on screen
 * that should catch the eye — so running rides `warning`, the same yellow the
 * running diamond already wears.
 */
function railColors(ctx: RenderCtx): { running: string; success: string; error: string; quiet: string } {
    return {
        running: hexOf(ctx, "warning", "#dcb77f"),
        success: hexOf(ctx, "success", "#a0cba5"),
        error: hexOf(ctx, "toolError", "#f5a5a7"),
        quiet: hexOf(ctx, "borderMuted", "#33333a"),
    };
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
export function renderThinking(state: ThinkingBlockState, ctx: RenderCtx): string[] {
    const th = ctx.theme;
    const bg = hexOf(ctx, "bgBase", "#141414");
    const bodyWidth = Math.max(20, ctx.width - RAIL_WIDTH - 1);
    const label =
        state.durationMs !== undefined
            ? `Thought for ${fmtSeconds(state.durationMs)}`
            : state.streaming
              ? "Thinking…"
              : "Thought";
    // Thinking rides its own hue rather than the tool accent — it is the one
    // block whose rail should read as "the model, not the machine". A settled
    // thought keeps that hue too: it has no success/failure outcome to report,
    // so mapping it onto the green/red pair would be a lie.
    const think = hexOf(ctx, "thinkingXhigh", "#beb6e8");
    const spec = railForState(
        { isPartial: state.streaming, expanded: state.expanded, selected: state.selected },
        { ...railColors(ctx), running: think, success: think, error: think },
        bg,
    );
    const diamond = fgHex(bulletColor(spec, bg, think), "◆");
    const header = fitRow(diamond + " " + th.fg("accentThinking", th.italic(label)), ctx.width - RAIL_WIDTH);

    // Every block owns exactly ONE leading blank (layout.blockGaps) — same
    // deterministic gap whether the transcript streamed live or replayed.
    if (!state.streaming && !state.expanded) {
        const hint = state.selected ? th.fg("dim", ` (${uiStyle().hints.selectedExpandHint} to expand)`) : "";
        return ["", ...withRail([fitRow(header + hint, ctx.width - RAIL_WIDTH)], spec, bg)];
    }
    const wrapped = state.text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, bodyWidth) : [""]));
    const body = state.streaming && !state.expanded ? wrapped.slice(-uiStyle().thinking.liveTailLines) : wrapped;
    return ["", ...withRail([header, ...body.map((l) => th.fg("thinkingText", th.italic(l)))], spec, bg)];
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
export function renderTool(state: ToolBlockState, ctx: RenderCtx): string[] | null {
    if (state.toolName === "plan") return null;
    const isTask = state.toolName === "task";
    const th = ctx.theme;
    const width = ctx.width - RAIL_WIDTH;
    const bodyWidth = Math.max(20, width - 1);
    const bg = hexOf(ctx, "bgBase", "#141414");

    // The diamond carries the state (grok's accent_running/success/error):
    // yellow while running, green on success, red on failure. The title text
    // stays muted once done (bright while running or selected).
    const failed = state.isError && !state.isPartial;
    const spec = railForState(state, railColors(ctx), bg);
    // While running, the diamond rides the head of its own rail's wave, so
    // bullet and line pulse as one mark (grok syncs them off the same curve).
    const diamond = state.isPartial
        ? fgHex(bulletColor(spec, bg, hexOf(ctx, "warning", "#dcb77f")), "◆")
        : th.fg(failed ? "toolError" : state.interrupted ? "muted" : "success", "◆");
    const titleColor = failed ? "toolError" : state.isPartial || state.selected ? "text" : "muted";

    /** Single exit: every return applies the rail and the block's lead gap. */
    const finish = (content: string[], spc: RailSpec | null = spec): string[] =>
        state.groupLead ? ["", ...withRail(content, spc, bg)] : withRail(content, spc, bg);

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
    const header = fitRow(diamond + " " + th.fg(titleColor, th.bold(name)) + detail + status, width);

    const lines = [header];
    const expandHint = (): void => {
        lines[0] = fitRow(lines[0] + th.fg("dim", ` (${uiStyle().hints.selectedExpandHint} to expand)`), width);
    };

    // Subagent body: the live activity tail while running; the full run log
    // when expanded. Each subagent turn/part is one log line.
    if (isTask) {
        if (!state.output) return finish(lines);
        const raw = state.output.split("\n");
        if (state.isPartial) {
            const tail = raw.slice(-uiStyle().thinking.liveTailLines);
            for (const l of tail.flatMap((x) => (x ? wrapTextWithAnsi(x, bodyWidth) : [""]))) {
                lines.push(th.fg("toolOutput", l));
            }
            return finish(lines);
        }
        if (!state.expanded) {
            if (state.selected) expandHint();
            return finish(lines);
        }
        for (const rawLine of raw) {
            for (const l of rawLine ? wrapTextWithAnsi(rawLine, bodyWidth) : [""]) {
                lines.push(th.fg(state.isError ? "toolError" : "toolOutput", l));
            }
        }
        return finish(lines);
    }

    // Streaming input (write/edit content) — live tail while the args arrive.
    if (state.isPartial && state.streamingContent && !state.output) {
        const tail = state.streamingContent.split("\n").slice(-uiStyle().thinking.liveTailLines);
        for (const l of tail.flatMap((x) => wrapTextWithAnsi(x, bodyWidth))) {
            lines.push(th.fg("toolOutput", l));
        }
        return finish(lines);
    }

    // Output: hidden while folded (grok's whole point), shown expanded.
    // Failures fold too — the red diamond + title carry the signal; expand
    // (nav →) to read the error.
    if (!state.output || !state.expanded) {
        if (state.output && state.selected) expandHint();
        return finish(lines);
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
            lines.push(prefix + diff);
        }
    }
    return finish(lines);
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
    /**
     * Noir's live variant (ctrl+e) — the same canvas, reading differently
     * because the transcript now has the keyboard.
     *
     * Grouping belongs here rather than in the base look: folding runs of
     * calls into "Read 3 files" is only worth the hidden detail when you can
     * open them again, which is exactly what live mode's arrows are for. In
     * the normal transcript the same fold would just be information you can't
     * get back without entering a mode first.
     */
    live: {
        tool: { group: true },
        // The transcript already has the keyboard here, so the route to hidden
        // content is just the arrow — no "ctrl+e first".
        hints: { expandHint: "→", selectedExpandHint: "→" },
    },
    render: { thinking: renderThinking, toolExecution: renderTool },
};

export function registerNoirMode(): void {
    registerUiMode(NOIR_MODE);
}
