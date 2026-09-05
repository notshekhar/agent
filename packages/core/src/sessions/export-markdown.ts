/**
 * /share — render a session branch as a readable Markdown transcript.
 * Pure transform: user/assistant text in full, tool calls collapsed to
 * one-liners, subagent reports and compactions summarized.
 */
import type { Session } from "./session";
import { extractMessageText } from "./session";

function oneLine(value: unknown, max = 120): string {
    let s: string;
    try {
        s = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        s = String(value);
    }
    s = (s ?? "").replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function sessionToMarkdown(session: Session): string {
    const lines: string[] = [];
    const name = session.getName();
    lines.push(`# ${name ?? `session ${session.id}`}`);
    lines.push("");
    lines.push(`- session: \`${session.id}\``);
    lines.push(`- model: \`${session.info.model}\``);
    lines.push(`- created: ${new Date(session.info.createdAt).toISOString()}`);
    lines.push("");

    for (const e of session.getBranch()) {
        if (e.type === "message") {
            if (e.role === "user") {
                const text = extractMessageText(e.content).trim();
                if (!text) continue;
                lines.push("## User");
                lines.push("");
                lines.push(text);
                lines.push("");
            } else if (e.role === "assistant") {
                const text = extractMessageText(e.content).trim();
                const calls = Array.isArray(e.content)
                    ? (e.content as Array<{ type?: string; toolName?: string; input?: unknown }>).filter(
                          (p) => p?.type === "tool-call",
                      )
                    : [];
                if (!text && calls.length === 0) continue;
                lines.push("## Assistant");
                lines.push("");
                for (const c of calls) lines.push(`> tool: \`${c.toolName}\` ${oneLine(c.input)}`);
                if (calls.length) lines.push("");
                if (text) {
                    lines.push(text);
                    lines.push("");
                }
            }
            // Tool results are omitted — the assistant's text references what
            // mattered, and raw outputs balloon the transcript.
        } else if (e.type === "subagent") {
            lines.push(`## Subagent (${(e as { agent?: string }).agent ?? "fork"})`);
            lines.push("");
            lines.push(String((e as { result?: unknown }).result ?? "").trim());
            lines.push("");
        } else if (e.type === "compact") {
            const c = e as { summary?: string; handoff?: string; rollover?: true };
            lines.push(c.rollover || c.handoff ? "## [fresh context window]" : "## [context compacted]");
            lines.push("");
            lines.push((c.handoff ?? c.summary)?.trim() ?? "");
            lines.push("");
        }
    }
    return `${lines.join("\n").trim()}\n`;
}
