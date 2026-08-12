/**
 * The left accent rail — the vertical line every transcript block hangs off.
 *
 * Ported from grok-build's column model (`scrollback/layout.rs`):
 *
 * ```text
 * │A│PL│      Content      │
 * │1│ 2│       flex        │
 * ```
 *
 * One column of rail, two of padding, then content. Header and body share the
 * same chrome, so a block reads as one object bracketed by a single line
 * instead of a title with a differently-indented body hanging under it.
 *
 * The rail also carries a block's state as MOTION rather than more text:
 *
 * - **running** — a `sin²` wave travels down the rail (grok's `wave_brightness`)
 * - **blocked** — the wave freezes into a slow whole-rail pulse, deliberately
 *   different motion so "working" and "waiting on you" are never confused
 * - **just finished** — a brief static full-colour beat as the call lands
 * - **settled** — the rail STAYS, static, in its outcome colour (green/red),
 *   held down toward the canvas. grok does the same (`execute.rs` swaps an
 *   animated accent for `accent_success`/`accent_error`), and it means a
 *   scrolled-back transcript still shows which calls worked at a glance,
 *   while only the live rail sits at full strength.
 */
import { animTick, accentAtBrightness, FINISH_FLASH_MS, pulseBrightness, waveBrightness } from "./anim";
import { mix } from "./palette";
import { fgHex } from "./theme";

/**
 * Both rail glyphs come from the BOX-DRAWING block, and that is the whole
 * requirement: box-drawing glyphs are designed to tile, so every font draws
 * them spanning the full cell and a column of them joins into one unbroken
 * line.
 *
 * grok uses `❙` (U+2759) for its collapsed rows, and that is the one thing not
 * worth copying — it is a Dingbats glyph, drawn as a SHORT bar inside the cell,
 * so a stack of consecutive collapsed rows renders as a dashed ladder with a
 * visible gap between every row rather than a rail. (Painting the column's
 * background instead is gapless, but a full-cell block is far too heavy a mark
 * for what should read as a thin rule — that treatment belongs only to bars
 * that are already solid, like the welcome banner's `█`.)
 *
 * So weight, not glyph family, carries the distinction: heavy for live and
 * open blocks, light for settled and folded ones. Both tile.
 */
const RAIL = "┃";
const RAIL_COLLAPSED = "│";

/** Columns the rail + its padding occupy. Content starts here. */
export const RAIL_WIDTH = 3;

export type RailMotion = "wave" | "pulse" | "static" | "none";

export interface RailSpec {
    /** The rail's colour at full brightness (hex). */
    color: string;
    motion: RailMotion;
    /** Use the thin glyph — a collapsed row inside a group. */
    collapsed?: boolean;
}

/**
 * Decide a block's rail from its display state. One place, so every mode and
 * every block type animate off the same rules.
 *
 * `colors` carries the theme's already-resolved hex for each role; the caller
 * owns slot choice (a tool's accent is not a thinking block's).
 */
export function railForState(
    state: {
        isPartial: boolean;
        isError?: boolean;
        interrupted?: boolean;
        expanded?: boolean;
        selected?: boolean;
        finishedAt?: number;
        blocked?: boolean;
    },
    colors: { running: string; success: string; error: string; quiet: string },
    bg?: string,
): RailSpec | null {
    if (state.isPartial) {
        // A call that has stopped to ask the user freezes its wave: the same
        // rail still says "this is the live one", but the motion says paused.
        return { color: colors.running, motion: state.blocked ? "pulse" : "wave" };
    }
    if (state.interrupted) return { color: colors.quiet, motion: "static", collapsed: !state.expanded };

    const settled = state.isError ? colors.error : colors.success;
    // The brief full-brightness beat as a call lands, before it settles.
    if (state.finishedAt !== undefined && Date.now() - state.finishedAt < FINISH_FLASH_MS) {
        return { color: settled, motion: "static" };
    }
    // Settled — and it STAYS. A finished call keeps its rail in its outcome
    // colour forever (grok's `execute.rs` does exactly this: animated while
    // running, `accent_success`/`accent_error` static after), so a scrolled-back
    // transcript still shows at a glance which calls worked and which didn't.
    //
    // Held down toward the canvas so a long transcript reads as a calm ladder
    // rather than a wall of saturated green — only the LIVE rail is at full
    // strength, which is what makes the running one findable.
    return {
        color: bg ? mix(bg, settled, state.expanded ? 0.55 : 0.4) : settled,
        motion: "static",
        collapsed: !state.expanded,
    };
}

/**
 * Prefix `lines` with the rail column and its padding.
 *
 * A null `spec` still pads, so content never shifts sideways when a block
 * stops animating — only the line itself appears and disappears.
 *
 * `bg` is the canvas the rail blends toward at the trough of its animation.
 */
export function withRail(lines: string[], spec: RailSpec | null, bg: string): string[] {
    const pad = " ".repeat(RAIL_WIDTH);
    if (!spec) return lines.map((l) => pad + l);

    const glyph = spec.collapsed ? RAIL_COLLAPSED : RAIL;
    const tick = animTick();
    return lines.map((line, row) => {
        let color = spec.color;
        if (spec.motion === "wave") color = accentAtBrightness(bg, spec.color, waveBrightness(row, tick));
        else if (spec.motion === "pulse") color = accentAtBrightness(bg, spec.color, pulseBrightness(tick), 0.3);
        return fgHex(color, glyph) + "  " + line;
    });
}

/**
 * The bullet's colour, synced to the head of its own rail's wave.
 *
 * grok animates the bullet off `wave_brightness(tick, row 0)` — the same curve
 * the rail's top row uses — so the glyph and the line it sits on pulse as one
 * mark rather than two things that happen to both be moving.
 */
export function bulletColor(spec: RailSpec | null, bg: string, fallback: string): string {
    if (!spec) return fallback;
    if (spec.motion === "wave") return accentAtBrightness(bg, spec.color, waveBrightness(0));
    if (spec.motion === "pulse") return accentAtBrightness(bg, spec.color, pulseBrightness(), 0.3);
    return spec.color;
}
