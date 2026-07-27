/**
 * LSP extension — code intelligence, in two halves.
 *
 * 1. Ambient diagnostics: after a `write` or `edit`, the changed file is run
 *    through every language server that handles it and the errors are appended
 *    to the tool result, so the agent sees what it just broke without being
 *    asked to go check. This is the half that changes behavior most, and it
 *    costs nothing when the file is clean.
 * 2. The `lsp` tool: nine navigation operations (definition, references, hover,
 *    symbols, implementation, call hierarchy) that answer semantically where
 *    `grep` can only answer textually.
 *
 * Everything rides the extension API: `onResult` for the diagnostics seam,
 * `tools.add` for the tool, `getOwn` for settings, and `deactivate` to reap the
 * server processes.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ExtensionAPI, ToolSummaryContext } from "../../api";
import { getLspManager, shutdownAllManagers } from "./manager";
import { LSP_OPERATIONS, type LspOperation, needsPosition, runOperation } from "./operations";
import { type Diagnostic, SEVERITY_LABEL } from "./protocol";

/** Errors only. Warnings are mostly style, and the agent acts on everything it is shown. */
const REPORTED_SEVERITY = 1;
/** Cap per file, so one catastrophically broken file can't flood the turn. */
const MAX_PER_FILE = 20;

function prettyDiagnostic(d: Diagnostic): string {
    const severity = SEVERITY_LABEL[d.severity ?? 1].toUpperCase();
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    return `${severity} [${line}:${col}] ${d.message.replace(/\s+/g, " ").trim()}`;
}

/** The `<diagnostics>` block appended to a write/edit result. Empty when clean. */
export function reportDiagnostics(cwd: string, absPath: string, diagnostics: Diagnostic[]): string {
    const errors = diagnostics.filter((d) => (d.severity ?? 1) === REPORTED_SEVERITY);
    if (errors.length === 0) return "";
    const rel = relative(cwd, absPath).replace(/\\/g, "/") || absPath;
    const shown = errors.slice(0, MAX_PER_FILE);
    const more = errors.length - shown.length;
    const suffix = more > 0 ? `\n... and ${more} more` : "";
    return `<diagnostics file="${rel}">\n${shown.map(prettyDiagnostic).join("\n")}${suffix}\n</diagnostics>`;
}

const OPERATION_HELP = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: List project-wide symbols matching a query string
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

Prefer this over grep for "where is this defined", "what calls this" and "what
does this type resolve to": it answers from the compiler's model of the code, so
it skips comments, strings and unrelated same-named symbols.

Position operations need filePath, line and character, all 1-based exactly as an
editor shows them and as the read tool's line numbers imply. documentSymbol needs
only filePath; workspaceSymbol needs only query (an empty string requests all
symbols, and filePath is used solely to pick which server answers).

A language server must be configured for the file type; if none is available an
error is returned.`;

/**
 * The one-line summary shown beside an `lsp` call. The default for a tool loop
 * doesn't ship is a truncated JSON dump of the arguments, which for a 5-field
 * call is unreadable — so the extension renders its own:
 *
 *   goToDefinition · src/main.ts:4:23
 *   workspaceSymbol · "greet"
 *   documentSymbol · src/main.ts
 *
 * Colour follows the active theme, and `noir` gets the operation in bold to
 * match its heavier row grammar; `loop` stays flat.
 */
export function summarizeLspCall(args: Record<string, unknown>, ctx: ToolSummaryContext): string {
    const operation = typeof args.operation === "string" ? args.operation : "lsp";
    const filePath = typeof args.filePath === "string" ? args.filePath : "";
    const rel = filePath.startsWith(ctx.cwd) ? filePath.slice(ctx.cwd.length).replace(/^[/\\]/, "") : filePath;

    let target: string;
    if (operation === "workspaceSymbol") {
        const query = typeof args.query === "string" ? args.query : "";
        target = query ? `"${query}"` : "(all symbols)";
    } else if (typeof args.line === "number" && typeof args.character === "number") {
        target = `${rel}:${args.line}:${args.character}`;
    } else {
        target = rel;
    }

    const op = ctx.uiMode === "noir" ? ctx.theme.bold(operation) : operation;
    return target ? `${op} ${ctx.theme.fg("muted", "·")} ${target}` : op;
}

function buildLspTool(cwd: () => string) {
    return tool({
        description: OPERATION_HELP,
        inputSchema: z.object({
            operation: z.enum(LSP_OPERATIONS).describe("The LSP operation to perform"),
            filePath: z.string().describe("The absolute or relative path to the file"),
            line: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe("The line number (1-based, as shown in editors). Required for position operations."),
            character: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe("The character offset (1-based, as shown in editors). Required for position operations."),
            query: z
                .string()
                .optional()
                .describe("Search query for workspaceSymbol. Empty string requests all symbols."),
        }),
        execute: async ({ operation, filePath, line, character, query }) => {
            const root = cwd();
            const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
            const op = operation as LspOperation;

            if (needsPosition(op) && (line === undefined || character === undefined)) {
                return `[${op} needs both line and character (1-based)]`;
            }
            const manager = getLspManager(root);
            const clients = await manager.clientsFor(abs);
            if (clients.length === 0) {
                return `[no language server available for ${filePath}. Install one for this file type, or add it to ~/.loop/servers/servers.json]`;
            }

            // A position request only answers about an open document.
            await Promise.all(clients.map(({ client }) => client.openDocument(abs)));

            const input = { operation: op, file: abs, line: line ?? 1, character: character ?? 1, query };
            const results = await Promise.all(
                clients.map(async ({ key, client }) => ({ key, ...(await runOperation(client, input, root)) })),
            );

            const lines = results.flatMap((r) => r.lines);
            if (lines.length === 0) {
                const all = results.every((r) => r.unsupported);
                if (all) {
                    const names = results.map((r) => r.key).join(", ");
                    return `[${op} is not supported by the language server for this file (${names})]`;
                }
                return `No results found for ${op}`;
            }
            // Dedupe: several servers answering one file repeat each other.
            return [...new Set(lines)].join("\n");
        },
    });
}

export default {
    activate(api: ExtensionAPI) {
        const enabled = () => api.settings.getOwn<boolean>("enabled", true) !== false;

        // After write/edit, diagnose the file on disk (works for both: the tool
        // has already written it). Appends a diagnostics block, or leaves the
        // result untouched when clean / unsupported / disabled. Never throws — a
        // diagnostics failure must not break an edit.
        api.tools.onResult(["write", "edit"], async (result, ctx) => {
            if (!enabled() || ctx.signal?.aborted) return;
            const rawPath = (ctx.input as { path?: string } | undefined)?.path;
            if (!rawPath) return;
            const absPath = isAbsolute(rawPath) ? rawPath : join(ctx.cwd, rawPath);
            try {
                const content = await readFile(absPath, "utf8");
                const diagnostics = await getLspManager(ctx.cwd).diagnose(absPath, content);
                const block = reportDiagnostics(ctx.cwd, absPath, diagnostics);
                if (!block) return;
                return `${result}\n\nLSP errors detected in this file, please fix:\n${block}`;
            } catch {
                return; // fail-open
            }
        });

        if (!enabled()) return;

        // Reading a file warms its server in the background, so the diagnostics
        // after the NEXT edit are already waiting instead of paying startup.
        api.tools.onResult("read", (_result, ctx) => {
            const rawPath = (ctx.input as { path?: string } | undefined)?.path;
            if (!rawPath || /^[a-z]+:\/\//i.test(rawPath)) return;
            const absPath = isAbsolute(rawPath) ? rawPath : join(ctx.cwd, rawPath);
            void getLspManager(ctx.cwd)
                .clientsFor(absPath)
                .catch(() => {});
        });

        let toolCwd = process.cwd();
        api.turn.use({
            onBeforeTurn(ctx) {
                toolCwd = ctx.cwd;
            },
        });
        api.tools.add(
            "lsp",
            buildLspTool(() => toolCwd),
        );
        // The read-only plan agent benefits most from navigation, and the tool
        // cannot mutate anything.
        // Own the tool's presentation too — the default renderer would print a
        // JSON dump of the arguments.
        api.tools.summary("lsp", summarizeLspCall);
        // The read-only plan agent benefits most from navigation, and the tool
        // cannot mutate anything.
        api.tools.grant("plan", "lsp");
    },

    async deactivate() {
        await shutdownAllManagers();
    },
};
