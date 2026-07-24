/**
 * Inline-keyboard builders for the Telegram bridge. Every panel-style TUI
 * command (/settings, /model, /sessions, /thinking, /extensions) becomes a
 * message with buttons; taps arrive as callback_query updates whose
 * callback_data is routed by prefix in bridge.ts. callback_data is capped at
 * 64 bytes by Telegram — long values (model ids) ride an index into a list
 * the bridge caches per menu instead.
 */
import type { InlineKeyboard } from "./api";
import { truncate } from "./render";

export interface SettingRow {
    key: string;
    label: string;
    value: boolean;
}

/** One button per setting, current state inline; tap = toggle in place. */
export function settingsKeyboard(rows: SettingRow[]): InlineKeyboard {
    return rows.map((row) => [{ text: `${row.label} · ${row.value ? "on" : "off"}`, callback_data: `set:${row.key}` }]);
}

export interface ModelRow {
    id: string;
    provider: string;
}

/** Step 1 of /model: pick a provider (two per row). */
export function providerKeyboard(models: ModelRow[]): InlineKeyboard {
    const providers = [...new Set(models.map((m) => m.provider))].sort();
    const rows: InlineKeyboard = [];
    for (let i = 0; i < providers.length; i += 2) {
        rows.push(providers.slice(i, i + 2).map((p) => ({ text: p, callback_data: `prov:${p}` })));
    }
    return rows;
}

/** Step 2 of /model: models of one provider, by index into the cached list. */
export function modelKeyboard(models: ModelRow[], currentId?: string): InlineKeyboard {
    return models.map((m, i) => [
        {
            text: `${m.id === currentId ? "· " : ""}${truncate(m.id, 48)}`,
            callback_data: `mdl:${i}`,
        },
    ]);
}

export interface SessionRow {
    id: string;
    label: string;
    running?: boolean;
}

export function sessionsKeyboard(rows: SessionRow[]): InlineKeyboard {
    return rows.map((row) => [
        {
            text: `${truncate(row.label, 40)}${row.running ? " · running" : ""}`,
            callback_data: `ses:${row.id}`,
        },
    ]);
}

/** Thinking levels, three per row, current one marked. */
export function thinkingKeyboard(levels: readonly string[], current?: string): InlineKeyboard {
    const rows: InlineKeyboard = [];
    for (let i = 0; i < levels.length; i += 3) {
        rows.push(
            levels.slice(i, i + 3).map((l) => ({
                text: l === current ? `· ${l}` : l,
                callback_data: `thk:${l}`,
            })),
        );
    }
    return rows;
}

export interface ExtensionRow {
    name: string;
    enabled: boolean;
}

export function extensionsKeyboard(rows: ExtensionRow[]): InlineKeyboard {
    // callback_data cap: skip pathological names that can't fit the prefix.
    return rows
        .filter((r) => Buffer.byteLength(`ext:${r.name}`) <= 64)
        .map((r) => [
            { text: `${truncate(r.name, 40)} · ${r.enabled ? "on" : "off"}`, callback_data: `ext:${r.name}` },
        ]);
}
