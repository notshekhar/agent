/**
 * Lua <-> JS value conversion.
 *
 * wasmoon hands a Lua table to JS as a plain object keyed by the Lua keys, so a
 * sequence `{"a","b"}` arrives as `{1:"a", 2:"b"}` — iteration order is not
 * guaranteed to be numeric, and `#t` is not `length`. Everything crossing the
 * boundary goes through here so that assumption lives in one place.
 */

/** A Lua value as wasmoon presents it. */
export type LuaValue = unknown;

/** Read a Lua sequence (1..n) as a JS array, in index order. */
export function toArray(value: LuaValue): unknown[] {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    if (typeof value !== "object") return [value];
    const entries = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [Number(k), v] as const)
        .filter(([k]) => Number.isFinite(k))
        .sort((a, b) => a[0] - b[0]);
    return entries.map(([, v]) => v);
}

/** Read a Lua sequence of strings, coercing numbers and dropping the rest. */
export function toStringArray(value: LuaValue): string[] {
    const out: string[] = [];
    for (const item of toArray(value)) {
        if (typeof item === "string") out.push(item);
        else if (typeof item === "number") out.push(String(item));
    }
    return out;
}

/** Read a Lua table as a string-keyed record (non-sequence fields). */
export function toRecord(value: LuaValue): Record<string, unknown> {
    if (value === null || typeof value !== "object") return {};
    return value as Record<string, unknown>;
}

export function asString(value: LuaValue): string | undefined {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return undefined;
}

export function asNumber(value: LuaValue): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: LuaValue): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}
