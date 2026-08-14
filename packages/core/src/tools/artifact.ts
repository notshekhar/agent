/**
 * artifact: reserve a standalone page under ~/.loop/artifacts and hand back the
 * path to write it to.
 *
 * **Create first, then write.** This tool never takes content. It returns an
 * ordinary absolute path, and the agent fills it in with the ordinary `write`
 * tool and revises it later with `edit` — so the artifact file IS the artifact,
 * with no copy to drift and nothing left behind in the user's repo.
 *
 * The tempting alternative was a fake path — `write` to `artifact://<id>` and
 * let the harness intercept — and it does not survive contact with the tool
 * layer: `resolveToCwd` mangles a scheme, `enforcePathPermission` matches user
 * globs like `Edit(src/**)` that cannot express one, the read-before-modify
 * registry is keyed on absolute paths, Claude-compatible hooks receive a
 * `file_path` that user scripts stat and lint, and `read`/`grep`/`ls` could not
 * open what the agent had just produced. Handing out a real path costs one tool
 * call and changes nothing underneath it.
 *
 * Opt-in via the `artifacts` setting (default OFF); attached conditionally in
 * runTurn like websearch/todo, so it is absent from the tool list entirely
 * until the user turns it on.
 */
import { pathToFileURL } from "node:url";
import { tool } from "ai";
import { z } from "zod";
import { artifactFilePath, createArtifact, MAX_ARTIFACT_BYTES, updateArtifactMeta } from "../artifacts";
import { formatPlanModeRefusal, isPlanModeActive } from "./utils/plan-mode";

export const ARTIFACT_TOOL_NAME = "artifact";

export interface ArtifactToolContext {
    abortSignal?: AbortSignal;
    /** Recorded on the artifact so a UI can link a page back to its chat. */
    sessionId?: string;
}

export function createArtifactTool(ctx: ArtifactToolContext) {
    return tool({
        description:
            "Create a shareable standalone page (an artifact) and get back a file path to write it to. " +
            "Use this when the user asks for a document, report, summary, write-up, or self-contained page that is a deliverable in itself rather than part of their codebase. " +
            "Do NOT use it for source files, config, or anything belonging to the project. " +
            "Call this FIRST, then write the returned path with the write tool. " +
            "To revise the artifact later, edit that same path — there is nothing to re-publish and the link never changes. " +
            "HTML must be self-contained and must open from a file:// URL: inline all CSS and JS, embed images as data: URIs, " +
            'no external requests, and use a plain <script> — <script type="module"> and fetch() do not work from file://. ' +
            "Pass an existing id to retitle an artifact instead of creating one.",
        inputSchema: z.object({
            title: z.string().describe("Short title for the page, shown in the artifact list"),
            kind: z
                .enum(["html", "markdown"])
                .describe("html for a rendered page, markdown for a plain document")
                .optional(),
            description: z.string().optional().describe("One sentence describing what the page is"),
            favicon: z.string().optional().describe("One or two emoji used as the page's icon"),
            id: z
                .string()
                .optional()
                .describe("Existing artifact id — updates its title/description instead of creating a new one"),
        }),
        execute: async ({ title, kind, description, favicon, id }, options) => {
            const signal = options?.abortSignal ?? ctx.abortSignal;
            if (signal?.aborted) throw new Error("Operation aborted");
            // Creating writes into ~/.loop/artifacts, so it is a mutation and
            // plan mode refuses it like write/edit.
            if (isPlanModeActive(ctx.sessionId)) throw new Error(formatPlanModeRefusal());

            if (id) {
                const meta = updateArtifactMeta(id, { title, description, favicon });
                return `Updated artifact "${meta.title}" (${meta.id})\n${artifactFilePath(meta)}`;
            }

            const meta = createArtifact({
                title,
                kind: kind ?? "html",
                description,
                favicon,
                sessionId: ctx.sessionId,
            });
            const path = artifactFilePath(meta);
            // The file:// URL is what the user opens. Stated up front so the
            // model can hand it over in its reply without another round trip.
            const url = pathToFileURL(path).href;
            return (
                `Created artifact "${meta.title}" (${meta.id}).\n` +
                `Write the content to: ${path}\n` +
                `It will open at: ${url}\n` +
                `Keep it under ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB. Edit that same path to revise it.`
            );
        },
    });
}
