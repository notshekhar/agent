/**
 * Minimal Language Server Protocol types + path<->URI conversion. We model the
 * slice we use: initialize, document sync, publishDiagnostics, and the
 * navigation requests behind the `lsp` tool (definition, references, hover,
 * symbols, implementation, call hierarchy). LSP speaks JSON-RPC framed with
 * `Content-Length` headers over a child process's stdio.
 */
import { pathToFileURL, fileURLToPath } from "node:url";

export type DiagnosticSeverity = 1 | 2 | 3 | 4; // Error | Warning | Information | Hint

export interface Position {
    line: number; // zero-based
    character: number; // zero-based
}

export interface Range {
    start: Position;
    end: Position;
}

export interface Diagnostic {
    range: Range;
    severity?: DiagnosticSeverity;
    code?: string | number;
    source?: string;
    message: string;
}

export interface PublishDiagnosticsParams {
    uri: string;
    version?: number;
    diagnostics: Diagnostic[];
}

export interface JsonRpcMessage {
    jsonrpc: "2.0";
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export function pathToUri(absPath: string): string {
    return pathToFileURL(absPath).toString();
}

export function uriToPath(uri: string): string {
    try {
        return fileURLToPath(uri);
    } catch {
        return uri.replace(/^file:\/\//, "");
    }
}

export const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
    1: "error",
    2: "warning",
    3: "info",
    4: "hint",
};

// --- navigation results (the `lsp` tool) -----------------------------------

/** A place in a file. `LocationLink` is the newer shape some servers return. */
export interface Location {
    uri: string;
    range: Range;
}

export interface LocationLink {
    targetUri: string;
    targetRange: Range;
    targetSelectionRange?: Range;
    originSelectionRange?: Range;
}

/** Flat symbol shape (`workspace/symbol`, older `documentSymbol` servers). */
export interface SymbolInformation {
    name: string;
    kind: number;
    containerName?: string;
    location: Location;
}

/** Nested symbol shape (modern `textDocument/documentSymbol`). */
export interface DocumentSymbol {
    name: string;
    detail?: string;
    kind: number;
    range: Range;
    selectionRange: Range;
    children?: DocumentSymbol[];
}

export interface Hover {
    contents: unknown;
    range?: Range;
}

export interface CallHierarchyItem {
    name: string;
    kind: number;
    detail?: string;
    uri: string;
    range: Range;
    selectionRange: Range;
}

export interface CallHierarchyIncomingCall {
    from: CallHierarchyItem;
    fromRanges: Range[];
}

export interface CallHierarchyOutgoingCall {
    to: CallHierarchyItem;
    fromRanges: Range[];
}

/** `SymbolKind` names, indexed by the protocol's 1-based enum. */
export const SYMBOL_KIND: Record<number, string> = {
    1: "file",
    2: "module",
    3: "namespace",
    4: "package",
    5: "class",
    6: "method",
    7: "property",
    8: "field",
    9: "constructor",
    10: "enum",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    15: "string",
    16: "number",
    17: "boolean",
    18: "array",
    19: "object",
    20: "key",
    21: "null",
    22: "enum-member",
    23: "struct",
    24: "event",
    25: "operator",
    26: "type-parameter",
};

/**
 * Flatten LSP's `MarkupContent | MarkedString | MarkedString[]` union into
 * plain text. Servers disagree on which they return, and the model only ever
 * wants the prose.
 */
export function hoverText(contents: unknown): string {
    const one = (value: unknown): string => {
        if (typeof value === "string") return value;
        if (value && typeof value === "object") {
            const v = value as { value?: unknown; language?: unknown };
            if (typeof v.value === "string") return v.value;
        }
        return "";
    };
    const parts = Array.isArray(contents) ? contents.map(one) : [one(contents)];
    return parts
        .map((p) => p.trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
}
