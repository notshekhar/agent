/** Reading message content the way the trace needs it: as text, in one line,
 * or as a tool result's printable form. */

/** A message content part, loosely typed — content is `unknown` on entries. */
export interface ContentPart {
    type?: string;
    text?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
}

export const partsOf = (content: unknown): ContentPart[] => (Array.isArray(content) ? (content as ContentPart[]) : []);

/** Tool outputs can be whole files; the trace keeps the head. */
export const OUTPUT_CAP = 6_000;

export function oneLine(value: unknown, max = 200): string {
    const s = (typeof value === "string" ? value : safeJson(value, false)).replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function safeJson(v: unknown, pretty = true): string {
    try {
        return (pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v)) ?? "";
    } catch {
        return String(v);
    }
}

/** A tool-result `output` in the AI SDK's tagged shape, as printable text. */
export function toolOutputText(output: unknown): string {
    if (output === undefined || output === null) return "";
    if (typeof output === "string") return output;
    const o = output as { type?: string; value?: unknown };
    if (typeof o.type !== "string" || !("value" in o)) return safeJson(output);
    switch (o.type) {
        case "text":
        case "error-text":
            return typeof o.value === "string" ? o.value : String(o.value ?? "");
        case "json":
        case "error-json":
            return safeJson(o.value);
        case "content":
            return Array.isArray(o.value)
                ? o.value
                      .map((part) => (part?.type === "text" ? String(part.text ?? "") : ""))
                      .filter(Boolean)
                      .join("\n")
                : safeJson(o.value);
        default:
            return safeJson(output);
    }
}

export function isErrorOutput(output: unknown): boolean {
    const type = (output as { type?: string } | undefined)?.type;
    return type === "error-text" || type === "error-json";
}
