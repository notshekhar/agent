/** Usage dialog: the steak (contribution heatmap), streak stats, and the
 * cost table — same rows as the CLI's /cost. */
import { byId } from "../../lib/dom";
import { escapeHtml, formatTokens } from "../../lib/format";
import { rpc } from "../../services/connection";
import { state } from "../../state";
import { openDialog } from "./frame";

export async function showUsage(): Promise<void> {
    openDialog("Usage");
    try {
        const [grid, stats, session] = await Promise.all([
            rpc("usage.steak"),
            rpc("cost.stats", { cwd: (state.current && state.current.cwd) || state.selectedProject || undefined }),
            state.current && state.current.id
                ? rpc("cost.session", { sessionId: state.current.id })
                : Promise.resolve(null),
        ]);
        const body = byId("dialogBody");
        body.innerHTML = "";

        // Dates per cell: startDay is the grid's column-0 Sunday (local).
        const startParts = String(grid.startDay || "")
            .split("-")
            .map(Number);
        const dateAt = (c: number, r: number) => {
            const d = new Date(startParts[0]!, (startParts[1] || 1) - 1, startParts[2] || 1);
            d.setDate(d.getDate() + c * 7 + r);
            return d;
        };
        const fmtDay = (d: Date) =>
            d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

        const steakHead = document.createElement("div");
        steakHead.className = "steak-head";
        steakHead.innerHTML =
            '<span class="steak-total">' +
            escapeHtml(formatTokens(grid.totalTokens)) +
            " tokens</span>" +
            '<span class="steak-sub">in the last year</span>';
        body.appendChild(steakHead);

        const scroll = document.createElement("div");
        scroll.className = "steak-scroll";
        const months = document.createElement("div");
        months.className = "steak-months";
        months.style.gridTemplateColumns = "repeat(" + grid.weeks + ", 12px)";
        for (const lbl of grid.monthLabels) {
            const s = document.createElement("span");
            s.textContent = lbl;
            s.style.overflow = "visible";
            s.style.whiteSpace = "nowrap";
            months.appendChild(s);
        }
        const wrap = document.createElement("div");
        wrap.className = "steak-grid";
        const days = document.createElement("div");
        days.className = "steak-days";
        ["", "Mon", "", "Wed", "", "Fri", ""].forEach((d) => {
            const s = document.createElement("span");
            s.textContent = d;
            days.appendChild(s);
        });
        const cols = document.createElement("div");
        cols.className = "steak-cols";
        for (let c = 0; c < grid.weeks; c++) {
            const col = document.createElement("div");
            col.className = "steak-col";
            for (let r = 0; r < 7; r++) {
                const lvl = grid.cells[r][c];
                const cell = document.createElement("div");
                cell.className = "cell " + (lvl < 0 ? "lv-b" : "lv-" + lvl);
                if (lvl >= 0) {
                    const tok = grid.tokens && grid.tokens[r] ? grid.tokens[r][c] : 0;
                    cell.title = fmtDay(dateAt(c, r)) + " — " + (tok > 0 ? formatTokens(tok) + " tokens" : "no usage");
                }
                col.appendChild(cell);
            }
            cols.appendChild(col);
        }
        wrap.append(days, cols);
        scroll.append(months, wrap);
        body.appendChild(scroll);

        const legend = document.createElement("div");
        legend.className = "steak-legend";
        legend.innerHTML =
            'Less <div class="cell lv-0"></div><div class="cell lv-1"></div><div class="cell lv-2"></div><div class="cell lv-3"></div><div class="cell lv-4"></div> More';
        body.appendChild(legend);

        // Streak stats come from core with the grid — same numbers as /steak.
        const st = grid.stats;
        const statTiles = document.createElement("div");
        statTiles.className = "stat-row";
        const tile = (val: string, name: string, note?: string) =>
            '<div class="stat"><div class="sval">' +
            escapeHtml(val) +
            '</div><div class="sname">' +
            escapeHtml(name) +
            (note ? ' <span class="snote">' + escapeHtml(note) + "</span>" : "") +
            "</div></div>";
        const fmtDays = (n: number) => n + (n === 1 ? " day" : " days");
        const fmtDayKey = (key: string) => {
            const [y, m, d] = String(key).split("-").map(Number);
            return fmtDay(new Date(y!, (m || 1) - 1, d || 1));
        };
        statTiles.innerHTML =
            tile(fmtDays(st.currentStreak), "current streak") +
            tile(fmtDays(st.longestStreak), "longest streak") +
            tile(String(st.activeDays), "active days") +
            tile(
                st.busiestDay ? formatTokens(st.busiestDayTokens) : "0",
                "busiest day",
                st.busiestDay ? fmtDayKey(st.busiestDay) : "",
            );
        body.appendChild(statTiles);

        // Cost table, same rows as the CLI's /cost.
        const table = document.createElement("div");
        table.className = "cost-table";
        const head = document.createElement("div");
        head.className = "cost-head";
        head.textContent = "Cost";
        table.appendChild(head);
        const usd = (v: number) => "$" + (v || 0).toFixed(4);
        const row = (label: string, val: string, extra?: string, sub?: boolean) => {
            const div = document.createElement("div");
            div.className = "cost-row" + (sub ? " sub" : "");
            div.innerHTML =
                '<span class="clabel">' +
                escapeHtml(label) +
                '</span><span class="cval">' +
                escapeHtml(val) +
                '</span><span class="cextra">' +
                escapeHtml(extra || "") +
                "</span>";
            table.appendChild(div);
        };
        if (session && typeof session.usd === "number") {
            row(
                "session",
                (session.estimated ? "~" : "") + usd(session.usd),
                "in:" +
                    formatTokens(session.inputTokens) +
                    " out:" +
                    formatTokens(session.outputTokens) +
                    " cache:" +
                    formatTokens(session.cachedInputTokens),
            );
        }
        const projCwd = (state.current && state.current.cwd) || state.selectedProject;
        if (projCwd) row("project", usd(stats.cwdUsd), projCwd);
        row("today", usd(stats.todayUsd));
        row("last 7 days", usd(stats.last7Usd));
        row("this month", usd(stats.monthUsd));
        row("lifetime", usd(stats.lifetimeUsd));
        const provs = Object.entries(stats.byProvider || {})
            .filter(([, v]) => (v as number) > 0)
            .sort((a, b) => (b[1] as number) - (a[1] as number));
        for (const [p, v] of provs) row(p, usd(v as number), "", true);
        body.appendChild(table);

        // Scroll the heatmap to the present (right edge).
        scroll.scrollLeft = scroll.scrollWidth;
    } catch (err: any) {
        byId("dialogBody").innerHTML =
            '<div class="block error">' + escapeHtml("failed to load usage: " + err.message) + "</div>";
    }
}
