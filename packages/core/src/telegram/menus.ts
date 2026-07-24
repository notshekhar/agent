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

/** Sessions shown per page. A phone shows this many rows plus the nav row
 * without the keyboard becoming a scroll of its own. */
export const SESSIONS_PAGE_SIZE = 8;

/**
 * One page of sessions, with a nav row when there is more than one page.
 * Paging is carried in the callback data (`sesp:<page>`) rather than held as
 * bridge state, so a menu still works after a restart and two menus open at
 * once can't fight over a shared cursor.
 */
export function sessionsKeyboard(rows: SessionRow[], page = 0, totalPages = 1): InlineKeyboard {
    const keyboard: InlineKeyboard = rows.map((row) => [
        {
            text: `${truncate(row.label, 40)}${row.running ? " · running" : ""}`,
            callback_data: `ses:${row.id}`,
        },
    ]);
    if (totalPages > 1) {
        const nav: InlineKeyboard[number] = [];
        // Wrap around: on a phone, reaching for a disabled button is worse than
        // a button that takes you to the other end of a short list.
        const prev = (page - 1 + totalPages) % totalPages;
        const next = (page + 1) % totalPages;
        nav.push({ text: "‹ prev", callback_data: `sesp:${prev}` });
        nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "nop:" });
        nav.push({ text: "next ›", callback_data: `sesp:${next}` });
        keyboard.push(nav);
    }
    return keyboard;
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
