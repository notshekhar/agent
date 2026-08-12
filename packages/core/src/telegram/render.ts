/**
 * Rendering for the Telegram bridge: model markdown → Telegram HTML,
 * 4096-limit chunking that never splits inside a tag or code fence, the
 * one-line tool grammar for live turn status, and the /cost /context /steak
 * text reports. Pure functions, no I/O — everything here is unit-testable.
 */
import type { ContextReport } from "../agent/context-report";
import type { SteakGrid } from "../agent/steak";
import type { CostStats } from "../agent/cost";
import { formatTokens } from "../format";
import type { CostBreakdown } from "../types";

/** Stay under Telegram's 4096 hard limit with margin for closing tags. */
export const CHUNK_LIMIT = 3900;

export function escapeHtml(s: string): string {
    return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

type Block = { kind: "code"; text: string; lang?: string } | { kind: "para"; text: string };

/** Split markdown into fence-delimited code blocks and paragraph blocks. */
function parseBlocks(md: string): Block[] {
    const blocks: Block[] = [];
    const lines = md.split("\n");
    let para: string[] = [];
    let code: string[] | null = null;
    let lang: string | undefined;

    const flushPara = () => {
        const text = para.join("\n").trim();
        if (text) for (const piece of text.split(/\n{2,}/)) blocks.push({ kind: "para", text: piece });
        para = [];
    };

    for (const line of lines) {
        const fence = line.match(/^\s*```(\S*)\s*$/);
        if (code !== null) {
            if (fence) {
                blocks.push({ kind: "code", text: code.join("\n"), lang });
                code = null;
            } else {
                code.push(line);
            }
        } else if (fence) {
            flushPara();
            code = [];
            lang = fence[1] || undefined;
        } else {
            para.push(line);
        }
    }
    // An unclosed fence (mid-stream preview) still renders as code.
    if (code !== null) blocks.push({ kind: "code", text: code.join("\n"), lang });
    else flushPara();
    return blocks;
}

/** Inline markdown → Telegram HTML for one paragraph. Inline code spans are
 * extracted first so no other transform can touch their contents. */
function renderInline(text: string): string {
    const codes: string[] = [];
    let out = text.replace(/`([^`\n]+)`/g, (_, c: string) => {
        codes.push(`<code>${escapeHtml(c)}</code>`);
        return `\u0000${codes.length - 1}\u0000`;
    });
    out = escapeHtml(out);
    // Links before bold/italic so URL punctuation can't be mangled.
    out = out.replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        (_, label: string, url: string) => `<a href="${url.replaceAll('"', "%22")}">${label}</a>`,
    );
    out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    out = out.replace(/(^|\s)\*([^*\s][^*\n]*?)\*(?=\s|[.,;:!?)]|$)/g, "$1<i>$2</i>");
    // Headings and bullets, line by line.
    out = out
        .split("\n")
        .map((line) => {
            const h = line.match(/^#{1,6}\s+(.*)$/);
            if (h) return `<b>${h[1]}</b>`;
            return line.replace(/^(\s*)[-*]\s+/, "$1• ");
        })
        .join("\n");
    return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)] ?? "");
}

function renderCode(text: string, lang?: string): string {
    const cls = lang && /^[\w+-]+$/.test(lang) ? ` class="language-${lang}"` : "";
    return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`;
}

/** A table separator row: only pipes, dashes, colons, spaces — at least one dash. */
function isSeparatorRow(line: string): boolean {
    return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

/**
 * If a GitHub-style pipe table starts at `start` (a row with a pipe, followed
 * by a separator row), return the exclusive end index of its rows; else -1.
 * Scanning for tables ANYWHERE in a block — not just at line 0 — is what lets a
 * table with a lead-in line ("Results:" right above it) still render as a table.
 */
function tableRegion(lines: string[], start: number): number {
    if (!lines[start]?.includes("|")) return -1;
    if (!isSeparatorRow(lines[start + 1] ?? "")) return -1;
    let end = start + 2;
    while (end < lines.length && lines[end].includes("|")) end++;
    return end;
}

/** Split a pipe-table row into trimmed cells, dropping the outer empties that a
 * leading/trailing `|` produces. */
function tableCells(line: string): string[] {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length && cells[0] === "") cells.shift();
    if (cells.length && cells[cells.length - 1] === "") cells.pop();
    return cells;
}

/**
 * A markdown table as column-aligned plain lines (header, rule, body) — the
 * only faithful way to show tabular data in Telegram, which has no table
 * markup. Returned as lines (not HTML) so an oversized table can be split
 * across messages without recomputing alignment or losing rows.
 */
function tableToLines(text: string): string[] {
    // Filter separators BY CONTENT, never by index: an index-based drop deletes
    // a real data row from every piece of a split table.
    const body = text
        .split("\n")
        .filter((l) => l.trim() && !isSeparatorRow(l))
        .map(tableCells);
    if (!body.length) return [];
    const cols = Math.max(...body.map((r) => r.length));
    const widths = Array.from({ length: cols }, (_, c) => Math.max(...body.map((r) => (r[c] ?? "").length)));
    const lines = body.map((r) =>
        Array.from({ length: cols }, (_, c) => (r[c] ?? "").padEnd(widths[c]))
            .join("  ")
            .trimEnd(),
    );
    // A rule under the header keeps it readable once alignment is monospace.
    if (lines.length > 1) lines.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "));
    return lines;
}

type Segment = { kind: "text" | "table"; text: string };

/** Split a paragraph block into alternating prose and table runs, so a table
 * introduced by a lead-in line is still rendered as a table. */
function segmentParagraph(text: string): Segment[] {
    const lines = text.split("\n");
    const segs: Segment[] = [];
    let buf: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const end = tableRegion(lines, i);
        if (end > 0) {
            if (buf.length) {
                segs.push({ kind: "text", text: buf.join("\n") });
                buf = [];
            }
            segs.push({ kind: "table", text: lines.slice(i, end).join("\n") });
            i = end;
        } else {
            buf.push(lines[i]);
            i++;
        }
    }
    if (buf.length) segs.push({ kind: "text", text: buf.join("\n") });
    return segs;
}

/** Split an oversized source text at line (then hard) boundaries so each
 * piece renders within the limit even after escaping. */
function splitSource(text: string, budget: number): string[] {
    const parts: string[] = [];
    let current = "";
    for (const line of text.split("\n")) {
        let piece = line;
        // A single line longer than the budget hard-wraps.
        while (piece.length > budget) {
            if (current) {
                parts.push(current);
                current = "";
            }
            parts.push(piece.slice(0, budget));
            piece = piece.slice(budget);
        }
        const joined = current ? `${current}\n${piece}` : piece;
        if (joined.length > budget) {
            parts.push(current);
            current = piece;
        } else {
            current = joined;
        }
    }
    if (current) parts.push(current);
    return parts;
}

/**
 * Markdown → one or more Telegram-HTML messages, each within the length
 * limit. Splits only between blocks; an oversized code block is split on
 * line boundaries and re-wrapped in <pre> per piece.
 */
export function markdownToTelegramChunks(md: string, limit = CHUNK_LIMIT): string[] {
    const rendered: string[] = [];
    // Escaping can triple length (& → &amp;) — budget source conservatively.
    const sourceBudget = Math.floor(limit / 2) - 32;
    for (const block of parseBlocks(md)) {
        if (block.kind === "code") {
            for (const piece of splitSource(block.text, sourceBudget)) rendered.push(renderCode(piece, block.lang));
            continue;
        }
        for (const seg of segmentParagraph(block.text)) {
            if (seg.kind === "table") {
                // Align once, then split the RENDERED lines — so a long table
                // keeps its column widths and never loses a row.
                const aligned = tableToLines(seg.text).join("\n");
                for (const piece of splitSource(aligned, sourceBudget)) {
                    rendered.push(`<pre>${escapeHtml(piece)}</pre>`);
                }
                continue;
            }
            const html = renderInline(seg.text);
            if (html.length <= limit) rendered.push(html);
            else for (const piece of splitSource(seg.text, sourceBudget)) rendered.push(renderInline(piece));
        }
    }
    const chunks: string[] = [];
    let current = "";
    for (const html of rendered) {
        const joined = current ? `${current}\n\n${html}` : html;
        if (joined.length > limit && current) {
            chunks.push(current);
            current = html;
        } else {
            current = joined;
        }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [""];
}

/** Tags out, entities back — the plain-text fallback when Telegram rejects
 * a chunk's HTML (isParseError). */
export function htmlToPlain(html: string): string {
    return html
        .replace(/<[^>]+>/g, "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
}

export function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    // Guard the slice: a max of 0/1 would otherwise slice(0, -1) and return
    // nearly the whole string.
    return max <= 1 ? "…" : `${s.slice(0, max - 1)}…`;
}

/** Longest raw text streamed into one Telegram message before the bridge rolls
 * to a new one. Under the 4096 hard limit with room for escaping (& → &amp;). */
export const STREAM_SOFT_LIMIT = 3500;

/** Live preview of a streaming text block: escaped plain text (no markdown
 * transforms — those risk unclosed tags mid-token), with a trailing cursor so
 * it visibly "types". The final render re-applies full markdown when sealed. */
export function streamPreview(text: string): string {
    return `${escapeHtml(text)}▌`;
}

/**
 * Pick where to end a streaming message that has grown past `limit`: the last
 * newline before the limit (so a message breaks between lines, not mid-word),
 * or a hard cut when a single line is longer than the limit. Returns the number
 * of characters that stay in the current message.
 */
export function streamCut(text: string, limit = STREAM_SOFT_LIMIT): number {
    if (text.length <= limit) return text.length;
    const nl = text.lastIndexOf("\n", limit);
    // Only break on a newline if it isn't uselessly early (avoids tiny messages).
    return nl > limit * 0.5 ? nl + 1 : limit;
}

/** Capitalized verb for a tool ("Bash", "Read"), the noir row grammar. */
export function toolVerb(toolName: string | undefined): string {
    const name = toolName ?? "tool";
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The salient argument of a tool call — the command for bash, the path for
 * file tools, etc. May be multi-line (bash); callers single-line it as needed. */
export function toolTarget(toolName: string | undefined, input: unknown): string {
    const name = toolName ?? "tool";
    const args = (input ?? {}) as Record<string, unknown>;
    const first = (...keys: string[]): string => {
        for (const k of keys) {
            const v = args[k];
            if (typeof v === "string" && v.trim()) return v.trim();
        }
        return "";
    };
    switch (name) {
        case "bash":
            return first("command");
        case "read":
        case "write":
        case "edit":
            return first("path", "file_path");
        case "grep":
        case "glob":
            return first("pattern");
        case "websearch":
            return first("query");
        case "fetch":
            return first("url");
        case "task":
            return first("description", "prompt");
        default:
            return Object.values(args).find((v): v is string => typeof v === "string" && !!v.trim()) ?? "";
    }
}

/** One status line per tool call — verb grammar ("Bash bun test", never a
 * "$ cmd" prompt), matching the noir row style. */
export function toolLine(toolName: string | undefined, input: unknown): string {
    const detail = toolTarget(toolName, input).split("\n")[0] ?? "";
    const verb = toolVerb(toolName);
    return detail ? `${verb} ${truncate(detail, 64)}` : verb;
}

/** Longest tool argument shown in a per-tool Telegram message before it's cut. */
const TOOL_MSG_DETAIL_MAX = 500;

/**
 * A tool call rendered as its own Telegram message: the bold verb, plus the
 * salient argument in a <pre> block (multi-line preserved for bash). `agent`
 * prefixes subagent tool calls. Returned HTML is safe to send with parse_mode
 * HTML and to append a status line to later (edit on completion).
 */
export function toolMessageHtml(toolName: string | undefined, input: unknown, agent?: string): string {
    const verb = toolVerb(toolName);
    const head = agent ? `<b>${escapeHtml(agent)}</b> · <b>${escapeHtml(verb)}</b>` : `<b>${escapeHtml(verb)}</b>`;
    const detail = truncate(toolTarget(toolName, input), TOOL_MSG_DETAIL_MAX);
    return detail ? `${head}\n<pre>${escapeHtml(detail)}</pre>` : head;
}

/** Minimal structural view of a session branch entry — enough to render a
 * transcript without importing the full Entry union. */
interface TranscriptEntry {
    type?: string;
    role?: string;
    content?: unknown;
    agent?: string;
    summary?: string;
}

function entryText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter(
                (c): c is { type: "text"; text: string } =>
                    !!c && typeof c === "object" && (c as { type?: string }).type === "text",
            )
            .map((c) => c.text)
            .join("");
    }
    return "";
}

function entryToolCalls(content: unknown): { toolName?: string; input?: unknown }[] {
    if (!Array.isArray(content)) return [];
    return content.filter(
        (p): p is { type: "tool-call"; toolName?: string; input?: unknown } =>
            !!p && typeof p === "object" && (p as { type?: string }).type === "tool-call",
    );
}

/**
 * Render a resumed session's branch as a sequence of Telegram messages — one
 * per user/assistant turn (tool calls condensed to one-liners), newest content
 * last. Only the final `maxTurns` message entries are shown; a header notes the
 * name, total, and any omission. Returns [] for an empty session.
 */
export function sessionTranscriptMessages(
    entries: TranscriptEntry[],
    opts: { name?: string; maxTurns?: number } = {},
): string[] {
    const maxTurns = opts.maxTurns ?? 12;
    const messages = entries.filter((e) => e.type === "message" || e.type === "subagent" || e.type === "compact");
    const shown = messages.slice(-maxTurns);
    const omitted = messages.length - shown.length;

    const header =
        `<b>resumed${opts.name ? ` · ${escapeHtml(opts.name)}` : ""}</b>` +
        (omitted > 0
            ? `\n<i>showing the last ${shown.length} of ${messages.length} — /export for the full transcript</i>`
            : "");

    const out: string[] = [header];
    for (const e of shown) {
        if (e.type === "compact") {
            out.push(`<i>[context compacted]</i>\n${escapeHtml(truncate(e.summary?.trim() ?? "", 500))}`);
            continue;
        }
        if (e.type === "subagent") {
            out.push(
                `<b>subagent · ${escapeHtml(e.agent ?? "fork")}</b>\n${escapeHtml(truncate(entryText(e.content).trim(), 800))}`,
            );
            continue;
        }
        if (e.role === "user") {
            const text = entryText(e.content).trim();
            if (text) out.push(`<b>You</b>\n${escapeHtml(truncate(text, 1200))}`);
        } else if (e.role === "assistant") {
            const text = entryText(e.content).trim();
            const calls = entryToolCalls(e.content).map((c) => `<i>${escapeHtml(toolLine(c.toolName, c.input))}</i>`);
            if (!text && calls.length === 0) continue;
            const parts = ["<b>Agent</b>"];
            if (calls.length) parts.push(calls.join("\n"));
            if (text) parts.push(escapeHtml(truncate(text, 1500)));
            out.push(parts.join("\n"));
        }
    }
    if (out.length <= 1) return [];

    // One message, not one per turn. Replaying a dozen turns as a dozen
    // messages fires a dozen phone notifications and buries the chat — the
    // transcript is one thing to read, so send it as one. Packing is greedy and
    // only ever splits BETWEEN entries: each entry is already length-capped
    // above, and cutting mid-entry would slice an HTML tag in half and make
    // Telegram reject the whole message.
    const packed: string[] = [];
    let current = "";
    for (const entry of out) {
        if (!current) {
            current = entry;
        } else if (current.length + SEPARATOR.length + entry.length <= CHUNK_LIMIT) {
            current += SEPARATOR + entry;
        } else {
            packed.push(current);
            current = entry;
        }
    }
    if (current) packed.push(current);
    return packed;
}

/** Blank line between replayed turns — they share one message now, so they
 * need something to read as separate turns. */
const SEPARATOR = "\n\n";

const usd = (n: number, decimals = 2): string => `$${n.toFixed(decimals)}`;

/** Label left, amount right, decimals in a column. Padding the label alone left
 * the amounts ragged ($12.34 under $0.4213), which reads as broken in a money
 * table — the digits are the part being compared. */
function moneyRows(rows: [string, string][]): string[] {
    const keyWidth = Math.max(...rows.map(([k]) => k.length));
    const valWidth = Math.max(...rows.map(([, v]) => v.length));
    return rows.map(([k, v]) => `${k.padEnd(keyWidth)}  ${v.padStart(valWidth)}`);
}

export function formatCost(stats: CostStats, session?: CostBreakdown): string {
    const rows: [string, string][] = [];
    if (session) rows.push(["session", `${session.estimated ? "~" : ""}${usd(session.usd, 4)}`]);
    rows.push(
        ["today", usd(stats.todayUsd)],
        ["7 days", usd(stats.last7Usd)],
        ["month", usd(stats.monthUsd)],
        ["lifetime", usd(stats.lifetimeUsd)],
    );
    const lines = moneyRows(rows);
    const providers = Object.entries(stats.byProvider)
        .filter(([, v]) => v > 0.005)
        .sort((a, b) => b[1] - a[1]);
    if (providers.length) {
        lines.push("");
        // Aligned within their own block: provider names and totals are a
        // separate table, and forcing them to share the summary's columns just
        // pushes one of the two out of shape.
        lines.push(...moneyRows(providers.map(([p, v]) => [p, usd(v)] as [string, string])));
    }
    return `<b>cost</b>\n<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

const BAR_WIDTH = 20;

/** ASCII for the same reason as STEAK_SHADES: `■` and `·` come from different
 * Unicode ranges, so a font substituting one and not the other makes the bar's
 * drawn width change with how full it is — the one thing a bar must not do. */
function bar(fraction: number): string {
    const filled = Math.round(Math.min(1, Math.max(0, fraction)) * BAR_WIDTH);
    return "#".repeat(filled) + ".".repeat(BAR_WIDTH - filled);
}

const compact = (n: number): string => formatTokens(n);

export function formatContext(report: ContextReport): string {
    const lines: string[] = [];
    const window = report.contextWindow || 1;
    lines.push(`${bar(report.totalTokens / window)}`);
    lines.push(`${compact(report.totalTokens)} / ${compact(report.contextWindow)} tokens used`);
    lines.push("");
    const width = Math.max(...report.categories.map((c) => c.label.length));
    for (const cat of report.categories) {
        if (cat.tokens <= 0) continue;
        lines.push(`${cat.label.padEnd(width)}  ${compact(cat.tokens).padStart(7)}`);
    }
    lines.push(`${"free".padEnd(width)}  ${compact(report.freeTokens).padStart(7)}`);
    return `<b>context</b> · ${escapeHtml(report.modelId)}\n<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

/**
 * Intensity ramp for the heatmap, deliberately ASCII.
 *
 * This was `·░▒▓█` — a middle dot plus three shade blocks and a full block,
 * drawn from three different Unicode ranges. Telegram's mobile code font
 * doesn't carry all of them, so it substitutes per glyph from fallback fonts
 * whose advance widths don't match, and the grid's columns come out ragged
 * however wide the block is. ASCII has no fallback to go wrong: every one of
 * these is in the base font at exactly one cell.
 */
const STEAK_SHADES = [".", ":", "+", "#", "@"] as const;

export function formatSteak(grid: SteakGrid): string {
    const lines: string[] = [];
    for (let day = 0; day < 7; day++) {
        let row = "";
        for (let week = 0; week < grid.weeks; week++) {
            const level = grid.cells[day]?.[week] ?? -1;
            row += level < 0 ? " " : STEAK_SHADES[level];
        }
        lines.push(row);
    }
    const s = grid.stats;
    const facts = [
        `${compact(grid.totalTokens)} tokens`,
        `${s.activeDays} active days`,
        `streak ${s.currentStreak} (best ${s.longestStreak})`,
    ];
    return `<b>steak</b>\n<pre>${escapeHtml(lines.join("\n"))}</pre>\n${escapeHtml(facts.join(" · "))}`;
}
