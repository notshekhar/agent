/**
 * Incremental view over a tool call's input while it is still streaming as raw
 * JSON text. A full JSON.parse can't work here — the buffer usually ends in the
 * middle of a string value — so this walks the partial object literal and pulls
 * out every top-level string field it has seen so far (for write: `path`, then
 * `content` growing chunk by chunk). Used by the live tool box to render a
 * write's file content as it streams instead of popping in only when complete.
 */

/** Decoded string starting at the opening quote `start`, the index just past
 * its closing quote, and whether that closing quote was reached. */
function readJsonString(json: string, start: number): { text: string; end: number; closed: boolean } {
    let out = "";
    let i = start + 1;
    while (i < json.length) {
        const c = json[i];
        if (c === '"') return { text: out, end: i + 1, closed: true };
        if (c === "\\") {
            const esc = json[i + 1];
            // Escape split across chunks — stop before it; the next delta completes it.
            if (esc === undefined) return { text: out, end: i, closed: false };
            if (esc === "u") {
                const hex = json.slice(i + 2, i + 6);
                if (hex.length < 4) return { text: out, end: i, closed: false };
                out += String.fromCharCode(Number.parseInt(hex, 16));
                i += 6;
                continue;
            }
            const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
            out += map[esc] ?? esc;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return { text: out, end: i, closed: false };
}

/**
 * Extract the top-level string fields of a partial JSON object literal.
 * The last value may still be mid-stream (its text so far is returned).
 * Bails out (returning what it has) at any nested object/array — the tools
 * this feeds (write) only have flat string fields.
 */
export function parsePartialToolInput(json: string): Record<string, string> {
    const out: Record<string, string> = {};
    let i = json.indexOf("{");
    if (i === -1) return out;
    i++;
    let key: string | null = null;
    while (i < json.length) {
        const c = json[i];
        if (c === '"') {
            const s = readJsonString(json, i);
            if (key === null) {
                if (!s.closed) break; // key itself still streaming
                key = s.text;
            } else {
                out[key] = s.text;
                if (!s.closed) break;
                key = null;
            }
            i = s.end;
        } else if (c === ":" || c === "," || c === " " || c === "\n" || c === "\r" || c === "\t") {
            i++;
        } else if (c === "}") {
            break;
        } else if (key !== null && (c === "{" || c === "[")) {
            break; // nested value — not a string field, stop here
        } else {
            // Non-string primitive (number/bool/null): skip to the next separator.
            while (i < json.length && json[i] !== "," && json[i] !== "}") i++;
            key = null;
        }
    }
    return out;
}
