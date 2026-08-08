import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { resolveToCwd } from "./utils/path-utils";
import { enforcePathPermission } from "./utils/permission-rules";
import { formatPlanModeRefusal, isPlanModeActive } from "./utils/plan-mode";
import { withFileMutationQueue } from "./utils/file-mutation-queue";
import { checkReadBeforeModify, recordModified } from "./utils/read-registry";
import { generateDiffString } from "./utils/edit-diff";

/**
 * Diff lines a write reports back to the UI.
 *
 * An overwrite can rewrite the whole file, so unlike `edit` — whose diff is
 * bounded by the blocks it replaced — this one has no natural ceiling. The
 * model never pays for it (see `toModelOutput`), but a 40,000-line diff still
 * has to cross the RPC socket and get rendered, so it is capped anyway.
 */
const MAX_DIFF_LINES = 200;

/**
 * Splits the model-facing summary from the UI-only diff.
 *
 * The result is one string so nothing downstream has to learn a new shape —
 * `tool-result` consumers, the CLI's renderer and the desktop's all take
 * `output` as text. `toModelOutput` cuts here; everything before the separator
 * is what the model is told, everything after is for human eyes only.
 */
const DIFF_SEPARATOR = "\n\n";

function capDiff(diff: string): string {
    const lines = diff.split("\n");
    if (lines.length <= MAX_DIFF_LINES) return diff;
    return `${lines.slice(0, MAX_DIFF_LINES).join("\n")}\n… ${lines.length - MAX_DIFF_LINES} more diff lines`;
}

export interface WriteToolContext {
    cwd: string;
    abortSignal?: AbortSignal;
    /** Scopes the read-before-edit registry (see tools/index.ts ToolContext). */
    sessionId?: string;
}

export function createWriteTool(ctx: WriteToolContext) {
    return tool({
        description:
            "Write content to a file, overwriting if it exists. Creates parent directories as needed. Overwriting an existing file requires having read all of it first (continue with offset= until the end). Use edit for targeted modifications of existing files.",
        inputSchema: z.object({
            path: z.string().describe("Path to write (relative or absolute)"),
            content: z.string().describe("Full file contents to write"),
        }),
        /**
         * The diff is for the user, not the model.
         *
         * Everything this tool could tell the model, the model already knows:
         * it supplied the full file content as this call's own argument. A diff
         * in the result would be that same content a second time — and not once,
         * but for the rest of the conversation, since the AI SDK persists what
         * THIS function returns (`toResponseMessages` → `createToolModelOutput`)
         * and loop replays those entries verbatim on every later turn and on
         * resume. So the model gets the one line it needs, and the raw return
         * value — diff and all — still reaches the `tool-result` event the UIs
         * render from.
         */
        toModelOutput: ({ output }) => ({
            type: "text",
            value: String(output).split(DIFF_SEPARATOR)[0] ?? String(output),
        }),
        execute: async ({ path, content }, options) => {
            const signal = options?.abortSignal ?? ctx.abortSignal;
            if (signal?.aborted) throw new Error("Operation aborted");
            // Plan mode gates every file mutation, in every permission mode.
            if (isPlanModeActive(ctx.sessionId)) throw new Error(formatPlanModeRefusal());
            const absolutePath = resolveToCwd(path, ctx.cwd);
            // Permission rules: Edit(...) patterns cover write too.
            await enforcePathPermission({
                classes: ["edit"],
                paths: [path, absolutePath],
                cwd: ctx.cwd,
                what: `Writing \`${path}\``,
                signal,
            });
            const dir = dirname(absolutePath);
            return withFileMutationQueue(absolutePath, async () => {
                if (signal?.aborted) throw new Error("Operation aborted");
                // Overwriting an existing file requires having read all of it
                // this session; new files/paths pass freely.
                let previous: string | null = null;
                if (existsSync(absolutePath)) {
                    const readError = checkReadBeforeModify(absolutePath, path, ctx.sessionId, {
                        requireComplete: true,
                        verb: ["write", "writing"],
                    });
                    if (readError) throw new Error(`${readError} (write would overwrite the existing file)`);
                    // Captured BEFORE the write, because that is the only moment
                    // it exists: once writeFile lands, what this call changed is
                    // unrecoverable. A file that cannot be read as text (binary,
                    // races with an external delete) simply reports no diff.
                    previous = await readFile(absolutePath, "utf-8").catch(() => null);
                }
                await mkdir(dir, { recursive: true });
                if (signal?.aborted) throw new Error("Operation aborted");
                await writeFile(absolutePath, content);
                recordModified(absolutePath, ctx.sessionId);
                // Byte length, not string length: `content.length` counts UTF-16
                // code units, so any non-ASCII file under-reports its own size.
                const summary = `Successfully wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${path}`;
                // A new file has nothing to diff against — the UI renders its
                // content as additions straight from the call's own input.
                if (previous === null) return summary;
                if (previous === content) return `${summary} (content unchanged)`;
                return `${summary}${DIFF_SEPARATOR}${capDiff(generateDiffString(previous, content).diff)}`;
            });
        },
    });
}
