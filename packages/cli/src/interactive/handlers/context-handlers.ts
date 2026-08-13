/**
 * /context — Claude-Code-style context-window breakdown: a 10×20 cell grid
 * (each cell = 0.5% of the window) with per-category colors, a legend, and a
 * per-skill token list. Categories are chars/4 estimates from core's
 * buildContextReport; the headline number prefers the provider-reported
 * context size when one exists.
 */
import { buildContextReport, formatTokens, getModelSync, type CommandContext } from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { dim, heading, strong } from "../ui/text";
import { theme } from "../ui/theme";

type ContextHandlers = Pick<CommandContext, "showContext">;

const GRID_ROWS = 10;
const GRID_COLS = 20;
const CELLS = GRID_ROWS * GRID_COLS;

const fmtTok = (n: number) => formatTokens(n);

export function createContextHandlers(state: AppState, deps: AppDeps): ContextHandlers {
    const { tui, history, showWorking, hideWorking } = deps;

    return {
        async showContext() {
            showWorking("Measuring context");
            let report;
            try {
                report = await buildContextReport({
                    session: state.session,
                    modelId: state.modelId,
                    cwd: state.cwd,
                    agent: state.agent !== "default" ? state.agent : undefined,
                });
            } catch (err) {
                hideWorking();
                history.addError(`context report failed: ${(err as Error).message}`);
                tui.requestRender();
                return;
            }
            hideWorking();

            const window = report.contextWindow;
            const info = getModelSync(state.modelId);
            // Headline prefers provider truth; the grid/legend are estimates.
            const usedHeadline = state.latestContextTokens > 0 ? state.latestContextTokens : report.totalTokens;

            if (window <= 0) {
                history.addSystem(heading("context"));
                for (const c of report.categories) {
                    history.addSystem(`  ${c.label.padEnd(18)}${fmtTok(c.tokens).padStart(8)} tokens`);
                }
                history.addSystem(dim("  (unknown context window for this model — no percentages)"));
                tui.requestRender();
                return;
            }

            // Cells per category: floor + at-least-one for any non-empty bucket.
            const cellsFor = report.categories.map((c) =>
                c.tokens > 0 ? Math.max(1, Math.round((c.tokens / window) * CELLS)) : 0,
            );
            const usedCells = Math.min(
                CELLS,
                cellsFor.reduce((a, b) => a + b, 0),
            );

            // Paint the flat cell list, then slice into rows.
            const cells: string[] = [];
            for (let i = 0; i < report.categories.length && cells.length < CELLS; i++) {
                for (let k = 0; k < cellsFor[i] && cells.length < usedCells; k++) {
                    cells.push(theme.series(i, "■"));
                }
            }
            while (cells.length < CELLS) cells.push(dim("·"));

            const pct = (n: number) => `${((n / window) * 100).toFixed(n > 0 && n / window < 0.001 ? 2 : 1)}%`;
            const legend = report.categories.map((c, i) => {
                const sw = theme.series(i, "■");
                return `${sw} ${c.label}: ${fmtTok(c.tokens)} tokens (${pct(c.tokens)})`;
            });
            const compactAt = Math.floor(window * report.autoCompactThreshold);

            // Info column pinned right of the grid rows.
            const side: string[] = new Array(GRID_ROWS).fill("");
            side[0] = strong(info?.name ?? state.modelId);
            side[1] = dim(state.modelId);
            side[2] = `${fmtTok(usedHeadline)}/${fmtTok(window)} tokens (${Math.round((usedHeadline / window) * 100)}%)`;
            side[4] = heading("Estimated usage by category");
            for (let i = 0; i < legend.length && 5 + i < GRID_ROWS; i++) side[5 + i] = legend[i];
            let next = 5 + legend.length;
            if (next < GRID_ROWS) {
                side[next++] = `${dim("·")} Free space: ${fmtTok(report.freeTokens)} (${pct(report.freeTokens)})`;
            }
            if (next < GRID_ROWS) {
                side[next] = dim(
                    `auto-compact at ${Math.round(report.autoCompactThreshold * 100)}% (${fmtTok(compactAt)})`,
                );
            }

            history.addSystem(heading("Context usage"));
            const overflow: string[] = [];
            // Legend lines that didn't fit beside the grid drop below it.
            if (5 + legend.length > GRID_ROWS) {
                overflow.push(...legend.slice(GRID_ROWS - 5));
                overflow.push(`${dim("·")} Free space: ${fmtTok(report.freeTokens)} (${pct(report.freeTokens)})`);
                overflow.push(
                    dim(`auto-compact at ${Math.round(report.autoCompactThreshold * 100)}% (${fmtTok(compactAt)})`),
                );
            }
            for (let r = 0; r < GRID_ROWS; r++) {
                const row = cells.slice(r * GRID_COLS, (r + 1) * GRID_COLS).join(" ");
                history.addSystem(`${row}${side[r] ? `   ${side[r]}` : ""}`);
            }
            for (const line of overflow) history.addSystem(line);

            if (report.skills.length > 0) {
                history.addSystem("");
                history.addSystem(heading("Skills"));
                report.skills.forEach((s, i) => {
                    const branch = i === report.skills.length - 1 ? "└" : "├";
                    history.addSystem(`${dim(branch)} ${s.name}: ${dim(`~${s.tokens} tokens`)}`);
                });
            }
            if (state.latestContextTokens > 0) {
                history.addSystem("");
                history.addSystem(
                    dim(
                        `categories are chars/4 estimates (${fmtTok(report.totalTokens)} total); headline uses the last provider-reported context size`,
                    ),
                );
            }
            tui.requestRender();
        },
    };
}
