/**
 * The nine navigation operations behind the `lsp` tool, and how their results
 * are rendered for the model.
 *
 * Positions cross three coordinate systems: the model speaks 1-based
 * line/character (what an editor shows, and what `read` output implies), LSP
 * speaks 0-based, and results come back 0-based and must be shown 1-based
 * again. The conversion happens here, once, at both ends.
 */
import { relative } from "node:path";
import type { LspClient } from "./client";
import {
    type CallHierarchyIncomingCall,
    type CallHierarchyItem,
    type CallHierarchyOutgoingCall,
    type DocumentSymbol,
    type Hover,
    hoverText,
    type Location,
    type LocationLink,
    type Range,
    SYMBOL_KIND,
    type SymbolInformation,
    pathToUri,
    uriToPath,
} from "./protocol";

export const LSP_OPERATIONS = [
    "goToDefinition",
    "findReferences",
    "hover",
    "documentSymbol",
    "workspaceSymbol",
    "goToImplementation",
    "prepareCallHierarchy",
    "incomingCalls",
    "outgoingCalls",
] as const;

export type LspOperation = (typeof LSP_OPERATIONS)[number];

/** Operations that need a position; the rest work on a file or the workspace. */
const POSITIONAL = new Set<LspOperation>([
    "goToDefinition",
    "findReferences",
    "hover",
    "goToImplementation",
    "prepareCallHierarchy",
    "incomingCalls",
    "outgoingCalls",
]);

export function needsPosition(operation: LspOperation): boolean {
    return POSITIONAL.has(operation);
}

/** The server capability that answers each operation, for a useful refusal. */
const CAPABILITY: Record<LspOperation, string> = {
    goToDefinition: "definitionProvider",
    findReferences: "referencesProvider",
    hover: "hoverProvider",
    documentSymbol: "documentSymbolProvider",
    workspaceSymbol: "workspaceSymbolProvider",
    goToImplementation: "implementationProvider",
    prepareCallHierarchy: "callHierarchyProvider",
    incomingCalls: "callHierarchyProvider",
    outgoingCalls: "callHierarchyProvider",
};

export interface OperationInput {
    operation: LspOperation;
    /** Absolute path to the target file. */
    file: string;
    /** 1-based, as the model supplies them. */
    line: number;
    character: number;
    query?: string;
}

/** A `file:line:col` label, repo-relative where possible. */
function where(cwd: string, uri: string, range: Range): string {
    const path = uriToPath(uri);
    const rel = relative(cwd, path);
    const shown = rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : path;
    return `${shown}:${range.start.line + 1}:${range.start.character + 1}`;
}

/** Definition/implementation results arrive as Location, LocationLink, or one of either. */
function toLocations(result: unknown): Location[] {
    if (!result) return [];
    const list = Array.isArray(result) ? result : [result];
    const out: Location[] = [];
    for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const loc = item as Partial<Location> & Partial<LocationLink>;
        if (typeof loc.uri === "string" && loc.range) {
            out.push({ uri: loc.uri, range: loc.range });
        } else if (typeof loc.targetUri === "string" && loc.targetRange) {
            out.push({ uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange });
        }
    }
    return out;
}

function isDocumentSymbol(value: unknown): value is DocumentSymbol {
    return !!value && typeof value === "object" && "selectionRange" in (value as object);
}

/** Render nested DocumentSymbols as an indented outline. */
function renderOutline(symbols: DocumentSymbol[], depth = 0): string[] {
    const out: string[] = [];
    for (const s of symbols) {
        const kind = SYMBOL_KIND[s.kind] ?? `kind:${s.kind}`;
        const detail = s.detail ? ` ${s.detail}` : "";
        out.push(`${"  ".repeat(depth)}${s.selectionRange.start.line + 1}: ${kind} ${s.name}${detail}`);
        if (s.children?.length) out.push(...renderOutline(s.children, depth + 1));
    }
    return out;
}

function renderFlatSymbols(cwd: string, symbols: SymbolInformation[]): string[] {
    return symbols.map((s) => {
        const kind = SYMBOL_KIND[s.kind] ?? `kind:${s.kind}`;
        const container = s.containerName ? ` (in ${s.containerName})` : "";
        return `${where(cwd, s.location.uri, s.location.range)}  ${kind} ${s.name}${container}`;
    });
}

function renderCallHierarchyItems(cwd: string, items: CallHierarchyItem[]): string[] {
    return items.map((item) => {
        const kind = SYMBOL_KIND[item.kind] ?? `kind:${item.kind}`;
        const detail = item.detail ? ` ${item.detail}` : "";
        return `${where(cwd, item.uri, item.selectionRange)}  ${kind} ${item.name}${detail}`;
    });
}

/**
 * Call hierarchy is two round trips: `prepareCallHierarchy` resolves the symbol
 * at the position into an item, and that item is what the calls request takes.
 */
async function callHierarchy(
    client: LspClient,
    input: OperationInput,
    direction: "incomingCalls" | "outgoingCalls",
    cwd: string,
): Promise<string[]> {
    const items = await prepare(client, input);
    if (items.length === 0) return [];
    const method = direction === "incomingCalls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
    const out: string[] = [];
    for (const item of items) {
        const calls = await client.send<(CallHierarchyIncomingCall | CallHierarchyOutgoingCall)[]>(method, { item });
        for (const call of calls ?? []) {
            const target = "from" in call ? call.from : call.to;
            const kind = SYMBOL_KIND[target.kind] ?? `kind:${target.kind}`;
            const arrow = direction === "incomingCalls" ? "called by" : "calls";
            out.push(`${arrow} ${kind} ${target.name}  ${where(cwd, target.uri, target.selectionRange)}`);
        }
    }
    return out;
}

function prepare(client: LspClient, input: OperationInput): Promise<CallHierarchyItem[]> {
    return client
        .send<CallHierarchyItem[]>("textDocument/prepareCallHierarchy", positionParams(input))
        .then((r) => r ?? []);
}

function positionParams(input: OperationInput) {
    return {
        textDocument: { uri: pathToUri(input.file) },
        position: { line: input.line - 1, character: input.character - 1 },
    };
}

export interface OperationResult {
    /** Rendered lines, empty when the operation found nothing. */
    lines: string[];
    /** Set when the server cannot answer this operation at all. */
    unsupported?: boolean;
}

/** Run one operation against one server. */
export async function runOperation(client: LspClient, input: OperationInput, cwd: string): Promise<OperationResult> {
    if (!client.supports(CAPABILITY[input.operation])) return { lines: [], unsupported: true };

    switch (input.operation) {
        case "goToDefinition": {
            const r = await client.send("textDocument/definition", positionParams(input));
            return { lines: toLocations(r).map((l) => where(cwd, l.uri, l.range)) };
        }
        case "goToImplementation": {
            const r = await client.send("textDocument/implementation", positionParams(input));
            return { lines: toLocations(r).map((l) => where(cwd, l.uri, l.range)) };
        }
        case "findReferences": {
            const r = await client.send("textDocument/references", {
                ...positionParams(input),
                context: { includeDeclaration: true },
            });
            return { lines: toLocations(r).map((l) => where(cwd, l.uri, l.range)) };
        }
        case "hover": {
            const r = await client.send<Hover>("textDocument/hover", positionParams(input));
            const text = r ? hoverText(r.contents) : "";
            return { lines: text ? text.split("\n") : [] };
        }
        case "documentSymbol": {
            const r = await client.send<(DocumentSymbol | SymbolInformation)[]>("textDocument/documentSymbol", {
                textDocument: { uri: pathToUri(input.file) },
            });
            const symbols = r ?? [];
            if (symbols.length === 0) return { lines: [] };
            // Servers return either shape; both are worth rendering natively.
            return isDocumentSymbol(symbols[0])
                ? { lines: renderOutline(symbols as DocumentSymbol[]) }
                : { lines: renderFlatSymbols(cwd, symbols as SymbolInformation[]) };
        }
        case "workspaceSymbol": {
            const r = await client.send<SymbolInformation[]>("workspace/symbol", { query: input.query ?? "" });
            return { lines: renderFlatSymbols(cwd, (r ?? []).slice(0, 100)) };
        }
        case "prepareCallHierarchy": {
            const items = await prepare(client, input);
            return { lines: renderCallHierarchyItems(cwd, items) };
        }
        case "incomingCalls":
        case "outgoingCalls":
            return { lines: await callHierarchy(client, input, input.operation, cwd) };
    }
}
