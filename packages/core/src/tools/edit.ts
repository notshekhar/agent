import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import {
    applyEditsToNormalizedContent,
    detectLineEnding,
    DIFF_SEPARATOR,
    generateDiffString,
    modelFacingResult,
    normalizeToLF,
    restoreLineEndings,
    stripBom,
    type Edit,
} from "./utils/edit-diff";
import { withFileMutationQueue } from "./utils/file-mutation-queue";
import { resolveToCwd } from "./utils/path-utils";
import { enforcePathPermission } from "./utils/permission-rules";
import { formatPlanModeRefusal, isPlanModeActive } from "./utils/plan-mode";
import { checkReadBeforeModify, recordModified } from "./utils/read-registry";

export interface EditToolContext {
    cwd: string;
    abortSignal?: AbortSignal;
    /** Scopes the read-before-edit registry (see tools/index.ts ToolContext). */
    sessionId?: string;
}

function prepareEditInput(input: unknown): { path: string; edits: Edit[] } {
    if (!input || typeof input !== "object") throw new Error("edit input must be an object");
    const args = input as Record<string, unknown>;
    // Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
    if (typeof args.edits === "string") {
        try {
            const parsed = JSON.parse(args.edits);
            if (Array.isArray(parsed)) args.edits = parsed;
        } catch {}
    }
    // Legacy flat oldText/newText → push into edits[]
    if (typeof args.oldText === "string" && typeof args.newText === "string") {
        const edits = Array.isArray(args.edits) ? [...(args.edits as Edit[])] : [];
        edits.push({ oldText: args.oldText, newText: args.newText });
        args.edits = edits;
    }
    if (!Array.isArray(args.edits) || (args.edits as Edit[]).length === 0) {
        throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
    }
    return { path: args.path as string, edits: args.edits as Edit[] };
}

export function createEditTool(ctx: EditToolContext) {
    return tool({
        description:
            "Edit a file by applying one or more targeted text replacements. Each replacement matches against the ORIGINAL file (not incrementally after prior edits). Use edit for precise changes; oldText must match exactly and uniquely. For multiple changes in one file, batch them into a single call's edits[] array. Do not emit overlapping or nested edits.",
        inputSchema: z.object({
            path: z.string().describe("Path to the file to edit (relative or absolute)"),
            edits: z
                .array(
                    z.object({
                        oldText: z
                            .string()
                            .describe(
                                "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
                            ),
                        newText: z.string().describe("Replacement text for this targeted edit."),
                    }),
                )
                .describe(
                    "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
                ),
        }),
        /**
         * The diff is for the user, not the model.
         *
         * The model already supplied every oldText/newText pair as this call's
         * own argument, so a diff in the result is that same content a second
         * time — and not once, but for the rest of the conversation, since the
         * AI SDK persists what THIS function returns (`toResponseMessages` →
         * `createToolModelOutput`) and loop replays those entries verbatim on
         * every later turn and on resume. Measured across the biggest sessions
         * on this machine, edit call-args and edit results were 201k and 227k
         * chars: the echo cost slightly MORE than the request it echoed.
         *
         * The raw return value — diff and all — still reaches the `tool-result`
         * event the UIs render from. Same contract as `write`.
         *
         * The one case where the diff IS news to the model is a fuzzy match:
         * the replaced span was not byte-identical to the oldText asked for, so
         * the file does not read the way the model thinks it does. Those
         * results carry no separator at all and reach the model whole.
         */
        toModelOutput: ({ output }) => ({ type: "text", value: modelFacingResult(output) }),
        execute: async (input, options) => {
            const signal = options?.abortSignal ?? ctx.abortSignal;
            if (signal?.aborted) throw new Error("Operation aborted");
            // Plan mode gates every file mutation, in every permission mode.
            if (isPlanModeActive(ctx.sessionId)) throw new Error(formatPlanModeRefusal());

            const { path, edits } = prepareEditInput(input);
            const absolutePath = resolveToCwd(path, ctx.cwd);

            // Permission rules: Edit(...) deny/ask patterns gate file edits.
            await enforcePathPermission({
                classes: ["edit"],
                paths: [path, absolutePath],
                cwd: ctx.cwd,
                what: `Editing \`${path}\``,
                signal,
            });

            return withFileMutationQueue(absolutePath, async () => {
                if (signal?.aborted) throw new Error("Operation aborted");
                // Read-before-edit: never modify a file the agent hasn't seen
                // (or has only seen a stale version of) this session.
                const readError = checkReadBeforeModify(absolutePath, path, ctx.sessionId);
                if (readError) throw new Error(readError);
                try {
                    await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
                } catch (err) {
                    const code =
                        err instanceof Error && "code" in err
                            ? `Error code: ${(err as { code?: string }).code}`
                            : String(err);
                    throw new Error(`Could not edit file: ${path}. ${code}.`);
                }
                if (signal?.aborted) throw new Error("Operation aborted");
                const buffer = await fsReadFile(absolutePath);
                const rawContent = buffer.toString("utf-8");
                if (signal?.aborted) throw new Error("Operation aborted");

                const { bom, text: content } = stripBom(rawContent);
                const originalEnding = detectLineEnding(content);
                const normalizedContent = normalizeToLF(content);
                const { baseContent, newContent, fuzzyEditIndexes } = applyEditsToNormalizedContent(
                    normalizedContent,
                    edits,
                    path,
                );

                if (signal?.aborted) throw new Error("Operation aborted");
                const finalContent = bom + restoreLineEndings(newContent, originalEnding);
                await fsWriteFile(absolutePath, finalContent);
                recordModified(absolutePath, ctx.sessionId);

                const diffResult = generateDiffString(baseContent, newContent);
                const summary = `Successfully replaced ${edits.length} block(s) in ${path}.`;
                // Fuzzy match: what got replaced is not what was asked for, so
                // the model is shown the diff — joined with single newlines so
                // the whole result stays on the model-facing side of the cut.
                if (fuzzyEditIndexes.length > 0) {
                    const which = fuzzyEditIndexes.map((i) => `edits[${i}]`).join(", ");
                    return [
                        summary,
                        `${which} matched text that differs from the oldText you sent (whitespace or unicode normalization), so the file does not read exactly the way you assumed. What actually changed:`,
                        diffResult.diff,
                    ].join("\n");
                }
                return `${summary}${DIFF_SEPARATOR}${diffResult.diff}`;
            });
        },
    });
}
