/** Context breakdown — the /context view: what fills the model's window.
 * Works for drafts too (fixed overhead a new session would start with). */
import { byId } from "../../lib/dom";
import { escapeHtml, formatTokens } from "../../lib/format";
import { rpc } from "../../services/connection";
import { state } from "../../state";
import { openDialog } from "./frame";

const CTX_COLORS: Record<string, string> = {
    systemPrompt: "#e5c07b",
    extensionPrompt: "#d19a66",
    systemTools: "#61afef",
    mcpTools: "#c678dd",
    workspaceContext: "#56b6c2",
    memory: "#98c379",
    skills: "#e06c75",
    messages: "#ff8648",
    compactSummary: "#f6c251",
};

export async function showContext(): Promise<void> {
    const current = state.current;
    if (!current) return;
    openDialog("Context");
    try {
        const report = await rpc(
            "context.report",
            current.draft
                ? { cwd: current.cwd, model: state.selectedModel || current.model }
                : { sessionId: current.id },
        );
        const body = byId("dialogBody");
        body.innerHTML = "";

        const win = report.contextWindow || 0;
        const used = report.totalTokens || 0;
        const pct = win > 0 ? Math.min(100, (used / win) * 100) : 0;

        const head = document.createElement("div");
        head.className = "ctx-head";
        head.innerHTML =
            '<span class="chl">' +
            escapeHtml(formatTokens(used)) +
            (win > 0 ? " / " + escapeHtml(formatTokens(win)) : "") +
            " tokens" +
            (win > 0 ? " (" + pct.toFixed(1) + "%)" : "") +
            "</span>" +
            '<span class="chm">' +
            escapeHtml(report.modelId || "") +
            "</span>";
        body.appendChild(head);

        if (win > 0) {
            const bar = document.createElement("div");
            bar.className = "ctx-bar";
            for (const c of report.categories) {
                if (!c.tokens) continue;
                const seg = document.createElement("div");
                seg.className = "seg";
                seg.style.width = Math.max(0.4, (c.tokens / win) * 100) + "%";
                seg.style.background = CTX_COLORS[c.key] || "var(--muted)";
                seg.title = c.label + " — " + formatTokens(c.tokens);
                bar.appendChild(seg);
            }
            if (report.autoCompactThreshold > 0 && report.autoCompactThreshold < 1) {
                const mark = document.createElement("div");
                mark.className = "compact-mark";
                mark.style.left = report.autoCompactThreshold * 100 + "%";
                mark.title = "auto-compact at " + Math.round(report.autoCompactThreshold * 100) + "%";
                bar.appendChild(mark);
            }
            body.appendChild(bar);
            if (report.autoCompactThreshold > 0 && report.autoCompactThreshold < 1) {
                const note = document.createElement("div");
                note.className = "ctx-marknote";
                note.textContent =
                    "auto-compacts at " + Math.round(report.autoCompactThreshold * 100) + "% of the window";
                body.appendChild(note);
            }
        }

        const row = (dotColor: string, label: string, tokens: number, cls?: string) => {
            const div = document.createElement("div");
            div.className = "ctx-row" + (cls ? " " + cls : "");
            div.innerHTML =
                '<span class="dot" style="background:' +
                dotColor +
                '"></span>' +
                '<span class="clabel">' +
                escapeHtml(label) +
                "</span>" +
                '<span class="ctok">' +
                escapeHtml(formatTokens(tokens)) +
                "</span>" +
                '<span class="cpct">' +
                (win > 0 ? ((tokens / win) * 100).toFixed(1) + "%" : "") +
                "</span>";
            body.appendChild(div);
        };
        for (const c of report.categories) {
            let label = c.label;
            if (c.key === "systemTools" && report.toolCount) label += " (" + report.toolCount + ")";
            if (c.key === "mcpTools" && report.mcpToolCount) label += " (" + report.mcpToolCount + ")";
            row(CTX_COLORS[c.key] || "var(--muted)", label, c.tokens);
        }
        if (win > 0) row("var(--bg-raise)", "Free space", report.freeTokens, "free");

        if (report.skills && report.skills.length) {
            const sk = document.createElement("div");
            sk.className = "ctx-skills";
            sk.innerHTML = '<div class="cost-head">Skills (' + report.skills.length + ")</div>";
            body.appendChild(sk);
            for (const s of report.skills.slice(0, 20)) {
                const div = document.createElement("div");
                div.className = "cost-row sub";
                div.innerHTML =
                    '<span class="clabel">' +
                    escapeHtml(s.name) +
                    '</span><span class="cval">' +
                    escapeHtml(formatTokens(s.tokens)) +
                    '</span><span class="cextra"></span>';
                sk.appendChild(div);
            }
        }

        const note = document.createElement("div");
        note.className = "ctx-marknote";
        note.style.marginTop = "12px";
        note.textContent =
            "estimates (chars/4)" + (current.draft ? " — draft session: fixed overhead only, no messages yet" : "");
        body.appendChild(note);
    } catch (err: any) {
        byId("dialogBody").innerHTML =
            '<div class="block error">' + escapeHtml("failed to load context report: " + err.message) + "</div>";
    }
}
