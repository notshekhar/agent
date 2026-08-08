/**
 * Incremental view over a tool call's input while it is still streaming as raw
 * JSON text.
 *
 * A full JSON.parse cannot work here — the buffer usually ends in the middle of
 * a string value — so these walk the partial object literal and pull out the
 * fields seen so far. This is what lets a `write` show its file content as it
 * arrives instead of popping in complete, which is how the terminal renders it.
 *
 * Ported verbatim from `packages/cli/src/interactive/ui/streaming-input.ts`
 * (pure, no node or ANSI dependencies). KEEP IN SYNC.
 */

/**
 * Decoded string starting at the opening quote `start`, the index just past its
 * closing quote, and whether that closing quote was reached.
 */
function readJsonString(
  json: string,
  start: number,
): { text: string; end: number; closed: boolean } {
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
 * this feeds (write, plan) only have flat string fields.
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

/**
 * Separator between edits in the live preview — visually splits hunks the way
 * the final diff will, without pretending to be one.
 */
const EDIT_SEPARATOR = "⋯";

/**
 * Extract `path` and the growing replacement text from edit's nested input
 * (`{ path, edits: [{ oldText, newText }, …] }`). Depth does not matter for
 * display, so instead of a full parser this walks every string in the buffer
 * and classifies it by the preceding significant character — `{`/`,` means
 * key, `:` means value — which is unambiguous in JSON at any nesting level.
 * Values whose key was `newText` (including a still-open last one) join into
 * `content`, so the row shows what is being written; oldText is skipped — the
 * result diff renders it better once the call completes.
 */
export function parsePartialEditInput(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  const newTexts: string[] = [];
  // `string | undefined` only because this app compiles with
  // noUncheckedIndexedAccess and the CLI does not; `i < json.length` already
  // guarantees a character.
  let lastSig: string | undefined = "";
  let lastKey: string | null = null;
  let i = json.indexOf("{");
  if (i === -1) return out;
  while (i < json.length) {
    const c = json[i];
    if (c === '"') {
      const s = readJsonString(json, i);
      if (lastSig === ":") {
        if (lastKey === "path") out.path = s.text;
        else if (lastKey === "newText") newTexts.push(s.text);
        lastKey = null;
      } else {
        if (!s.closed) break; // key still streaming
        lastKey = s.text;
      }
      if (!s.closed) break;
      lastSig = '"';
      i = s.end;
    } else {
      if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") lastSig = c;
      i++;
    }
  }
  if (newTexts.length > 0) out.content = newTexts.join(`\n${EDIT_SEPARATOR}\n`);
  return out;
}

/** Only these three stream a preview; the CLI buffers exactly the same set. */
export function toolStreamsItsInput(toolName: string): boolean {
  return toolName === "write" || toolName === "edit" || toolName === "plan";
}

/** The field view for a partial input, picked by the tool (edit nests its own). */
export function parsePartialInput(toolName: string, json: string): Record<string, string> {
  return toolName === "edit" ? parsePartialEditInput(json) : parsePartialToolInput(json);
}
