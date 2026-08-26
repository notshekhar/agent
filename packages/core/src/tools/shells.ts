/**
 * `shells` — read, list and kill the background shells `bash` started.
 *
 * One multi-op tool rather than three single-purpose ones: every tool's schema
 * rides every request, and reading/killing/listing are the same small surface
 * over the same registry (the same reason `sql` is one tool and not five).
 */
import { tool } from "ai";
import { z } from "zod";
import { formatDuration, killShell, listShells, readShell, type ShellInfo } from "./utils/shell-registry";

export const SHELLS_TOOL_NAME = "shells";

function statusText(s: ShellInfo): string {
    if (s.status === "running") return `running ${formatDuration(Date.now() - s.startedAt)}`;
    if (s.status === "killed") return "killed";
    if (s.status === "failed") return "failed to start";
    return s.exitCode === 0 ? "exited 0" : `exited ${s.exitCode ?? "?"}`;
}

function line(s: ShellInfo): string {
    const unread = s.bytes - s.cursor;
    const tail = unread > 0 && s.status !== "running" ? ` · ${unread}B unread` : "";
    return `${s.id}  ${statusText(s)}  ${s.command.split("\n")[0].slice(0, 70)}${tail}`;
}

export interface ShellsToolContext {
    sessionId?: string;
}

export function createShellsTool(ctx: ShellsToolContext) {
    return tool({
        description:
            "Inspect the background shells started by bash with run_in_background.\n\n" +
            "- output: return what the shell has printed SINCE YOUR LAST READ, and mark it read. " +
            "Repeated calls do not repeat old output. Pass `filter` (a regex) to keep only matching lines — " +
            "use it on chatty processes like dev servers.\n" +
            "- kill: terminate the shell and its whole process tree.\n" +
            "- list: every shell in this session with its status.\n\n" +
            "You are told automatically when a background shell exits — do NOT poll in a loop or sleep " +
            "waiting for one. Read its output when you are told it finished, or when you actually need it.",
        inputSchema: z.object({
            action: z.enum(["output", "kill", "list"]).describe("What to do. `list` ignores `id`."),
            id: z.string().optional().describe("Shell id, e.g. bash_1. Required for output and kill."),
            filter: z.string().optional().describe("Regex; only matching lines are returned. `output` only."),
        }),
        execute: async ({ action, id, filter }) => {
            if (action === "list") {
                const all = listShells(ctx.sessionId);
                if (all.length === 0) return "No background shells in this session.";
                return all.map(line).join("\n");
            }

            if (!id) throw new Error(`shells: \`id\` is required for action "${action}" (e.g. bash_1).`);

            if (action === "kill") {
                const info = killShell(ctx.sessionId, id);
                if (!info) throw new Error(unknownShell(ctx.sessionId, id));
                return `${id} killed (${info.command.split("\n")[0].slice(0, 70)}).`;
            }

            const result = readShell(ctx.sessionId, id, { filter });
            if (!result) throw new Error(unknownShell(ctx.sessionId, id));
            const { info, text, skippedBytes, filteredOut } = result;

            const notes: string[] = [];
            if (skippedBytes > 0) notes.push(`${skippedBytes}B of older output skipped — full log: ${info.logPath}`);
            if (filteredOut > 0) notes.push(`${filteredOut} lines hidden by filter`);
            const status = `[${info.id} ${statusText(info)}]`;

            if (!text.trim()) {
                const why = filteredOut > 0 ? "no matching output" : "no new output";
                return [`${status} ${why} since last read.`, ...notes.slice(1)].join("\n");
            }
            return [status, ...notes, "", text].join("\n");
        },
    });
}

function unknownShell(sessionId: string | undefined, id: string): string {
    const all = listShells(sessionId);
    if (all.length === 0) return `shells: no shell ${id} — nothing is running in this session.`;
    return `shells: no shell ${id}. Known: ${all.map((s) => s.id).join(", ")}.`;
}

/**
 * Ephemeral reminder announcing shells that exited since the last step, for
 * the turn's prepareStep seam. Rides one request and is never persisted, so it
 * cannot bust the prompt-cache prefix — the same contract as the todo nudge.
 *
 * This is what makes "do not poll" honest: opencode's background shells tell
 * the model "you will be notified when it completes", and a model that is not
 * actually notified has no choice but to sleep-and-check.
 */
export function formatShellNotices(exited: ShellInfo[]): string | null {
    if (exited.length === 0) return null;
    const rows = exited.map((s) => {
        const unread = s.bytes - s.cursor;
        const how =
            s.status === "killed"
                ? "was killed"
                : s.status === "failed"
                  ? "failed to start"
                  : `exited with code ${s.exitCode ?? "?"}`;
        const cmd = s.command.split("\n")[0].slice(0, 70);
        const tail = unread > 0 ? `; ${unread} bytes unread` : "";
        return `${s.id} (${cmd}) ${how}${tail}.`;
    });
    return (
        "<system-reminder>Background shell update: " +
        rows.join(" ") +
        " Read anything you still need with the shells tool. Ignore this if it no longer matters." +
        "</system-reminder>"
    );
}
