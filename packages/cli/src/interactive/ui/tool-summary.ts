/**
 * Single source of truth for how a tool call is summarized on one line — used
 * by the live tool box (tool-execution.ts) and the /tree row (entry-display.ts)
 * so both describe a call identically. Pure + uncolored; callers apply theme.
 */

/** Shorten an absolute path under `cwd` to a repo-relative one (or `.` for cwd). */
function rel(p: unknown, cwd: string): string {
    if (typeof p !== "string") return "";
    return p.startsWith(cwd) ? p.slice(cwd.length).replace(/^\//, "") || "." : p;
}

/**
 * One-line argument summary for a tool call. Empty string when there's nothing
 * useful to show (e.g. a pending call whose input hasn't streamed yet).
 */
export function formatToolArgs(toolName: string, args: Record<string, unknown>, cwd: string): string {
    if (Object.keys(args).length === 0) return "";
    const a = args;
    switch (toolName) {
        case "read":
        case "write":
        case "edit":
        case "ls":
            return rel(a.path ?? a.file_path ?? a.filePath, cwd);
        case "bash": {
            const cmd = typeof a.command === "string" ? a.command : "";
            const firstLine = cmd.split("\n")[0];
            return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
        }
        case "grep":
            return [a.pattern, rel(a.path, cwd)].filter(Boolean).join(" in ");
        case "find":
            return typeof a.pattern === "string" ? a.pattern : "";
        case "websearch":
            return typeof a.query === "string" ? a.query : "";
        case "skill":
            return typeof a.name === "string" ? a.name : "";
        case "sql": {
            const conn = typeof a.connectionId === "string" ? a.connectionId : "";
            const q = typeof a.query === "string" ? a.query.replace(/\s+/g, " ").trim() : "";
            const qShort = q.length > 60 ? `${q.slice(0, 57)}…` : q;
            return [conn, qShort].filter(Boolean).join(" · ");
        }
        case "plan": {
            // The plan body renders as markdown below the title — the summary
            // is its first heading, never the raw JSON blob.
            const plan = typeof a.plan === "string" ? a.plan : "";
            const heading = (plan.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim();
            return heading.length > 80 ? `${heading.slice(0, 77)}…` : heading;
        }
        default: {
            const json = JSON.stringify(a);
            return json.length > 80 ? `${json.slice(0, 77)}…` : json;
        }
    }
}

/** `read`'s `:start` / `:start-end` line range from offset/limit, or "". */
export function readLineRangeText(args: Record<string, unknown>): string {
    const offset = typeof args.offset === "number" ? args.offset : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    if (offset === undefined && limit === undefined) return "";
    const start = offset ?? 1;
    const end = limit !== undefined ? start + limit - 1 : "";
    return `:${start}${end ? `-${end}` : ""}`;
}

/** A `[…]`-only result line — the read tool's notices, never file content. */
const READ_NOTICE_RE = /^\[.*\]$/;

/**
 * Right-aligned absolute line numbers for a `read` result, one prefix per
 * output line (empty string = don't number this line).
 *
 * The numbering starts at the call's `offset`, not at 1: an offset read shows
 * the file's real line numbers, which is the whole point — a preview that
 * restarts at 1 can't be matched back to the file it came from.
 *
 * The tool appends its own `[Showing lines … ]` / `[N more lines … ]` notice
 * after a blank line, and a whole-result notice (image file, over-limit line)
 * is a message rather than a body — neither gets a number.
 */
export function readGutterPrefixes(lines: string[], args: Record<string, unknown>): string[] {
    if (lines.length === 0) return [];
    if (lines.length === 1 && READ_NOTICE_RE.test(lines[0].trim())) return [""];
    const base = typeof args.offset === "number" ? args.offset : 1;
    let bodyEnd = lines.length;
    if (bodyEnd >= 2 && READ_NOTICE_RE.test(lines[bodyEnd - 1].trim()) && lines[bodyEnd - 2].trim() === "") {
        bodyEnd -= 2;
    }
    const width = String(base + Math.max(0, bodyEnd - 1)).length;
    return lines.map((_, i) => (i < bodyEnd ? `${String(base + i).padStart(width)}  ` : ""));
}

/**
 * Full one-line invocation label for a resolved tool call: `toolName summary`.
 * `task` shows its agent + prompt snippet; `read` appends its line range. Used
 * for /tree rows and search text, where no live status is available.
 */
export function formatToolInvocation(toolName: string, args: Record<string, unknown>, cwd: string): string {
    if (toolName === "task") {
        const agent = typeof args.agent === "string" ? args.agent : "default";
        const prompt = typeof args.prompt === "string" ? args.prompt.split("\n")[0].slice(0, 60) : "";
        return prompt ? `task ${agent}: ${prompt}` : `task ${agent}`;
    }
    const summary = formatToolArgs(toolName, args, cwd);
    const range = toolName === "read" ? readLineRangeText(args) : "";
    return summary ? `${toolName} ${summary}${range}` : toolName;
}
