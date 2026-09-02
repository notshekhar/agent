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

/**
 * A tool call's arguments as one readable line. Raw JSON is what the model
 * sent, but `{"command":"cd /x && ls"}` reads worse than `cd /x && ls`, and a
 * ledger of those is unscannable. The argument a human would name the call by
 * comes first and unlabelled; the rest keep their keys.
 */
const HEADLINE_ARGS = [
    "command",
    "cmd",
    // a search's identity is what it searched for, not where
    "pattern",
    "query",
    "file_path",
    "path",
    "url",
    "prompt",
    "description",
    "content",
    "name",
];

export function toolInputLine(input: unknown, max = 200): string {
    if (input === null || input === undefined) return "";
    if (typeof input !== "object" || Array.isArray(input)) return oneLine(input, max);
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== "");
    if (keys.length === 0) return "";
    const rank = (k: string) => {
        const i = HEADLINE_ARGS.indexOf(k);
        return i === -1 ? HEADLINE_ARGS.length : i;
    };
    const ordered = keys.slice().sort((a, b) => rank(a) - rank(b) || keys.indexOf(a) - keys.indexOf(b));
    const parts = ordered.map((k, i) => {
        const v = obj[k];
        const text = typeof v === "string" ? v : safeJson(v, false);
        return i === 0 && rank(k) < HEADLINE_ARGS.length ? text : `${k}: ${text}`;
    });
    return oneLine(parts.join(" · "), max);
}
