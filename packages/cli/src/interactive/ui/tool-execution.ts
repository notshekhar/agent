/**
 * Own tool execution renderer for our 7 tools:
 * status-colored box, bold title with a per-tool arg summary, output that
 * collapses to a preview and expands with ctrl+e, diff coloring for edit/write,
 * syntax highlighting for read.
 */
import { Box, Container, Markdown, Spacer, Text, type TUI } from "@notshekhar/loop-tui";
import { normalizePlanText } from "@notshekhar/loop-core";
import { getLanguageFromPath, getMarkdownTheme, highlightCode, theme } from "./theme";
import { formatToolArgs, readGutterPrefixes, readLineRangeText } from "./tool-summary";
import { uiRenderers, uiStyle } from "./ui-mode";
import { markSelectedLines } from "./messages";
import { foldsEagerly } from "./verb-group";
/** Live-streaming preview cap in EXPANDED mode. Highlighting runs on every
 * flush while input streams — unbounded, a large file made a single frame
 * expensive enough to freeze the box. The full content still renders once
 * the call completes (the result path has no such cap). */
const STREAMING_EXPANDED_LINES = 200;

export interface ToolResultLike {
    content: Array<{ type: string; text?: string }>;
    isError: boolean;
}

/** Per-run summary a finished task box shows in its title (all optional —
 * older persisted runs may miss any of them). */
export interface TaskStatsLike {
    steps?: number;
    durationMs?: number;
    usd?: number;
}

/** `41s` under a minute, `2m05s` beyond — compact enough for a title line. */
export function formatTaskDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export class ToolExecutionComponent extends Container {
    private box: Box;
    private expanded = false;
    private isPartial = true;
    private result?: ToolResultLike;
    /** Live status shown in the title while partial (subagent: current tool). */
    private statusText = "";
    /** Live input while the call's args stream (write: file content so far). */
    private streamingContent = "";
    /** Finished task run summary — steps/duration/cost in the done title. */
    private taskStats?: TaskStatsLike;
    /** Highlighted by the block-selection navigation (ctrl+up/down). */
    private selected = false;
    /** First call of a consecutive tool group (see ToolBlockState.groupLead). */
    private groupLead = true;
    /** The turn was aborted while this call was still running. */
    private interrupted = false;
    /** When this call stopped running (`Date.now()`), for the finish flash —
     * the brief full-colour rail a block wears as it settles. Stays unset on
     * replayed transcripts, whose calls were never seen running. */
    private finishedAt?: number;
    /** State changed since the box was last built. The box is rebuilt lazily
     * at render time: a mode's toolExecution renderer replaces the box
     * entirely, and building it anyway (highlighting, diff coloring) on every
     * streaming delta was pure waste under such modes. */
    private boxDirty = true;

    setGroupLead(lead: boolean): void {
        this.groupLead = lead;
    }

    /** The turn ended (abort) with this call still pending — freeze it as
     * "interrupted" instead of leaving a running spinner forever. */
    markInterrupted(): void {
        if (this.result && !this.isPartial) return; // finished normally
        this.isPartial = false;
        this.interrupted = true;
        this.statusText = "";
        this.finishedAt = Date.now();
        this.boxDirty = true;
    }

    constructor(
        private toolName: string,
        private args: Record<string, unknown>,
        private tui: TUI,
        private cwd: string,
    ) {
        super();
        this.addChild(new Spacer(1));
        this.box = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
        this.addChild(this.box);
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
        this.boxDirty = true;
    }

    isExpanded(): boolean {
        return this.expanded;
    }

    /** The tool this row calls — the key a verb group aggregates on. */
    getToolName(): string {
        return this.toolName;
    }

    /** Did this call fail? (Feeds the group header's "· N failed" suffix.) */
    hasError(): boolean {
        return this.result?.isError ?? false;
    }

    /** Still streaming. A running call never joins a group, so this only ever
     * reports the row's own state — see {@link isGroupable}. */
    isRunning(): boolean {
        return this.isPartial;
    }

    /**
     * Whether this row may be swallowed into a verb group.
     *
     * Four gates. A RUNNING call never groups: live mode is the base mode plus
     * folding, not a different way to watch a turn — while a call is in flight
     * it renders exactly the row noir renders normally, showing which file is
     * being read and its live status. Only once it lands does it fold into the
     * header with the calls before it. Grouping mid-flight was tried (it holds
     * the transcript height still) and hid the one thing you look at the
     * transcript mid-turn to see.
     *
     * An OPEN call also leaves the group — the user asked to see that one —
     * and `plan` never joins, being an approval surface that must stay
     * readable.
     *
     * The last gate is the tool's KIND. Nearly every kind folds, including
     * commands and third-party (MCP / extension) calls; `edit` is the
     * exception, because which file changed is the information and it is what
     * gets reviewed. See verb-group.ts for the vocabulary.
     */
    isGroupable(): boolean {
        return !this.isPartial && !this.expanded && this.toolName !== "plan" && foldsEagerly(this.toolName);
    }

    /** Selection highlight for the ctrl+up/down block navigation. */
    setSelected(selected: boolean): void {
        this.selected = selected;
    }

    updateResult(result: ToolResultLike, isPartial = false): void {
        const wasRunning = this.isPartial;
        this.result = result;
        this.isPartial = isPartial;
        if (!isPartial) {
            this.statusText = "";
            this.streamingContent = "";
            // Only the running→done edge starts a flash. A late result update
            // on an already-finished call must not re-flash it.
            if (wasRunning) this.finishedAt = Date.now();
        }
        this.boxDirty = true;
        this.tui.requestRender();
    }

    /** Live input fields while the call's args stream in (before `tool-call`):
     * the path fills the title as soon as it's known, the content renders as a
     * growing tail under it. */
    updateStreamingInput(fields: Record<string, string>): void {
        if (fields.path && this.args.path !== fields.path) this.args = { ...this.args, path: fields.path };
        // plan streams its text under "plan"; write/edit under "content".
        this.streamingContent = fields.content ?? fields.plan ?? "";
        this.boxDirty = true;
        this.tui.requestRender();
    }

    updateStatus(status: string): void {
        this.statusText = status;
        this.boxDirty = true;
        this.tui.requestRender();
    }

    /** Attach a finished task run's summary — rendered in the done title. */
    setTaskStats(stats: TaskStatsLike): void {
        this.taskStats = stats;
        this.boxDirty = true;
        this.tui.requestRender();
    }

    /** Fill in the args once the tool's input has finished streaming (the box was
     * created as a pending stub on `tool-input-start` with no args yet). */
    updateArgs(args: Record<string, unknown>): void {
        this.args = args;
        this.boxDirty = true;
        this.tui.requestRender();
    }

    override invalidate(): void {
        super.invalidate();
        this.boxDirty = true;
    }

    override render(width: number): string[] {
        const lines = this.renderInner(width);
        return this.selected ? markSelectedLines(lines) : lines;
    }

    /** Copy payload for the y key: the call one-liner plus its output. */
    copyText(): string {
        const title = `${this.toolName} ${this.argsSummary()}`.trim();
        const output = this.outputText();
        return output ? `${title}\n${output}` : title;
    }

    private renderInner(width: number): string[] {
        const override = uiRenderers().toolExecution;
        if (override) {
            const lines = override(
                {
                    toolName: this.toolName,
                    args: this.args,
                    summary: this.argsSummary(),
                    output: this.outputText(),
                    isError: this.result?.isError ?? false,
                    isPartial: this.isPartial,
                    expanded: this.expanded,
                    selected: this.selected,
                    groupLead: this.groupLead,
                    interrupted: this.interrupted,
                    statusText: this.statusText,
                    streamingContent: this.streamingContent,
                    taskStats: this.taskStats,
                    cwd: this.cwd,
                    finishedAt: this.finishedAt,
                },
                { width, theme },
            );
            if (lines) return lines;
        }
        if (this.boxDirty) {
            this.rebuildBox();
            this.boxDirty = false;
        }
        return super.render(width);
    }

    /** (Re)build the default box's children from current state. Called lazily
     * from render — never eagerly on state changes (see boxDirty). */
    private rebuildBox(): void {
        // Subagents (task tool) keep the purple custom-message background as
        // their identity — pending and done alike; errors still go red.
        const isTask = this.toolName === "task";
        this.box.setBgFn(
            this.result?.isError && !this.isPartial
                ? (text: string) => theme.bg("toolErrorBg", text)
                : isTask
                  ? (text: string) => theme.bg("customMessageBg", text)
                  : this.isPartial || this.interrupted
                    ? (text: string) => theme.bg("toolPendingBg", text)
                    : (text: string) => theme.bg("toolSuccessBg", text),
        );
        this.box.clear();
        this.box.addChild(new Text(this.titleLine(), 0, 0));

        // sql: render the query as a highlighted SQL block instead of leaving it
        // as a raw JSON arg blob.
        const inputLines = this.inputPreview();
        if (inputLines) {
            this.box.addChild(new Spacer(1));
            this.box.addChild(new Text(inputLines.join("\n"), 0, 0));
        }

        // plan: the input IS the deliverable — render it as full markdown (no
        // collapse) so the user actually reads what they're approving, and drop
        // the one-line ack output. While the input still streams the raw tail
        // renders via streamingLines below, like write.
        if (this.toolName === "plan" && !this.result?.isError) {
            const plan = typeof this.args.plan === "string" ? normalizePlanText(this.args.plan.trim()) : "";
            if (plan) {
                this.box.addChild(new Spacer(1));
                this.box.addChild(new Markdown(plan, 0, 0, getMarkdownTheme()));
                return;
            }
        }

        // Streaming write: the file content renders live (tail-capped) while
        // the input is still arriving; the diff replaces it once done.
        const streaming = this.streamingLines();
        if (streaming) {
            this.box.addChild(new Spacer(1));
            this.box.addChild(new Text(streaming.join("\n"), 0, 0));
        }

        const output = this.outputText();
        if (!output) return;

        const lines = this.colorOutput(output.split("\n"));
        // Collapsed → short preview capped at the mode's collapsedLines;
        // expanded (ctrl+e) → the full output, no cap.
        const cap = uiStyle().tool.collapsedLines;
        const truncated = !this.expanded && lines.length > cap;
        const shown = truncated ? lines.slice(0, cap) : lines;

        this.box.addChild(new Spacer(1));
        this.box.addChild(new Text(shown.join("\n"), 0, 0));
        if (truncated) {
            this.box.addChild(
                new Text(
                    theme.fg("dim", `… +${lines.length - cap} lines (${uiStyle().hints.expandHint} to expand)`),
                    0,
                    0,
                ),
            );
        }
    }

    /** Title color by state: pending/stale grey, failed vivid red, done normal.
     * Modes with mutedCollapsed grey the finished title while folded. */
    private titleColor(): "muted" | "toolError" | "toolTitle" {
        if (this.isPartial || this.interrupted) return "muted";
        if (this.result?.isError) return "toolError";
        if (uiStyle().tool.mutedCollapsed && !this.expanded) return "muted";
        return "toolTitle";
    }

    /** `toolname summary` — bold name, muted single-line arg summary. */
    private titleLine(): string {
        // Subagent header: `task <agent> · <state> · <prompt snippet>` where
        // state is the live tool while running, then done/failed.
        if (this.toolName === "task") {
            const agent = typeof this.args.agent === "string" ? this.args.agent : "default";
            const state = this.isPartial
                ? this.statusText || "running"
                : this.result?.isError
                  ? "failed"
                  : ["done", ...this.taskStatsParts()].join(" · ");
            const snippet = typeof this.args.prompt === "string" ? this.args.prompt.split("\n")[0].slice(0, 50) : "";
            const bullet = uiStyle().tool.bullet;
            const title =
                (bullet ? theme.fg(this.titleColor(), `${bullet} `) : "") +
                theme.fg(this.titleColor(), theme.bold(`task ${agent}`));
            return `${title} ${theme.fg("muted", snippet ? `${state} · ${snippet}` : state)}`;
        }
        const bullet = uiStyle().tool.bullet;
        const title =
            (bullet ? theme.fg(this.titleColor(), `${bullet} `) : "") +
            theme.fg(this.titleColor(), theme.bold(this.toolName));
        const summary = this.argsSummary();
        if (!summary) return title;
        // `read` appends its offset/limit as a warning-colored `:start-end`
        // suffix; the range sits outside the muted wrap so it
        // keeps its own color.
        const range = this.toolName === "read" ? this.readLineRange() : "";
        return `${title} ${theme.fg("muted", summary)}${range}`;
    }

    /** `12 steps · 41s · $0.0430` fragments — only what the run recorded. */
    private taskStatsParts(): string[] {
        const s = this.taskStats;
        if (!s) return [];
        const parts: string[] = [];
        if (s.steps) parts.push(`${s.steps} step${s.steps === 1 ? "" : "s"}`);
        if (s.durationMs !== undefined) parts.push(formatTaskDuration(s.durationMs));
        if (s.usd !== undefined) parts.push(`$${s.usd.toFixed(4)}`);
        return parts;
    }

    private argsSummary(): string {
        // Shared with the /tree row (tool-summary.ts) so both describe a call
        // the same way; the empty-args guard lives inside formatToolArgs.
        return formatToolArgs(this.toolName, this.args, this.cwd);
    }

    /**
     * `read` line range — `:start` or `:start-end` from offset/limit, empty
     * when neither is set. Themed wrap around the shared plain-text range.
     */
    private readLineRange(): string {
        const range = readLineRangeText(this.args);
        return range ? theme.fg("warning", range) : "";
    }

    /** Streamed input content while partial: the last few lines (or all of them
     * when expanded), syntax-highlighted by the target path. Only the shown tail
     * is highlighted — the full content may be large and this runs per delta. */
    private streamingLines(): string[] | null {
        if (!this.isPartial || this.result || !this.streamingContent) return null;
        const raw = this.streamingContent.split("\n");
        // Expanded mode is capped too: the preview re-highlights on every
        // flush, so an unbounded window froze the TUI on large files.
        const cap = this.expanded ? STREAMING_EXPANDED_LINES : uiStyle().tool.collapsedLines;
        const truncated = raw.length > cap;
        const shown = truncated ? raw.slice(-cap) : raw;
        const lang = getLanguageFromPath(String(this.args.path ?? ""));
        const lines = lang ? highlightCode(shown.join("\n"), lang) : shown.map((l) => theme.fg("toolOutput", l));
        if (!truncated) return lines;
        const hint = this.expanded ? "streaming" : `${uiStyle().hints.expandHint} to expand`;
        return [...lines, theme.fg("dim", `… +${raw.length - cap} earlier lines (${hint})`)];
    }

    /** sql: the query, highlighted as a SQL block under the title. */
    private inputPreview(): string[] | null {
        if (this.toolName !== "sql") return null;
        const query = typeof this.args.query === "string" ? this.args.query.trim() : "";
        if (!query) return null;
        return highlightCode(query, "sql");
    }

    private outputText(): string {
        if (!this.result) return "";
        return this.result.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text)
            .join("\n")
            .trimEnd();
    }

    private colorOutput(lines: string[]): string[] {
        if (this.result?.isError) {
            return lines.map((l) => theme.fg("toolError", l));
        }
        // edit/write results contain unified diffs — color +/- lines
        if (this.toolName === "edit" || this.toolName === "write") {
            return lines.map((l) => {
                if (l.startsWith("+")) return theme.fg("toolDiffAdded", l);
                if (l.startsWith("-")) return theme.fg("toolDiffRemoved", l);
                return theme.fg("toolDiffContext", l);
            });
        }
        if (this.toolName === "read") {
            const lang = getLanguageFromPath(String(this.args.path ?? this.args.file_path ?? ""));
            // Highlight first, then prepend the gutter: the line numbers are
            // chrome, and feeding them to the highlighter colors them as code.
            const body = lang ? highlightCode(lines.join("\n"), lang) : lines.map((l) => theme.fg("toolOutput", l));
            const gutters = readGutterPrefixes(lines, this.args);
            return body.map((l, i) => (gutters[i] ? theme.fg("dim", gutters[i]) + l : l));
        }
        return lines.map((l) => theme.fg("toolOutput", l));
    }
}
