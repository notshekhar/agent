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
import { fgHex, verticalRule } from "./theme";

/**
 * The rail is a LEFT HALF BLOCK, and one glyph serves every state.
 *
 * It has to tile — a column of them must join into one unbroken mark, with no
 * gap between rows. That rules out grok's `❙` (U+2759), a Dingbats glyph drawn
 * as a short bar inside its cell, which stacks into a dashed ladder rather
 * than a rail. Box-drawing and block-element glyphs both tile; the difference
 * is weight, and weight is the whole point here.
 *
 * This used to be a pair — `┃` for live and open blocks, `│` for settled and
 * folded ones — on the theory that weight should carry the state. In practice
 * a finished transcript is almost entirely settled blocks, so the theory made
 * the common case a page of thin grey hairlines and the distinction was never
 * visible anyway: you cannot compare two weights that are never on screen
 * together. So STATE IS COLOUR — a yellow wave while running, green or red
 * once settled, held down toward the canvas when folded — and weight is
 * constant.
 *
 * `▎` is a QUARTER block, and the quarter is deliberate. The obvious choice is
 * the half block `▌`, but that is the SELECTION bar (markSelectedLines), which
 * overwrites this very column when a block is selected. Sharing a glyph would
 * reduce "this block is selected" to a colour change on a mark that was
 * already there, when it needs to be the most obvious thing on the screen.
 * A quarter against a half is a step you cannot miss, and the selection stays
 * the heaviest mark in the transcript — which is the right order of priority.
 *
 * Being a block element it is painted through {@link verticalRule} rather than
 * drawn directly: a terminal whose line height exceeds the font's glyph box
 * (Terminal.app) would otherwise stack it into a dashed ladder, which is the
 * one thing a rail must never be. That path paints a cell background instead,
 * and is gapless everywhere.
 */
const RAIL = "▎";

/** Columns the rail + its padding occupy. Content starts here. */
export const RAIL_WIDTH = 3;

export type RailMotion = "wave" | "pulse" | "static" | "none";

export interface RailSpec {
    /** The rail's colour at full brightness (hex). */
    color: string;
    motion: RailMotion;
    /**
     * The block is folded. No longer changes the GLYPH (there is only one) —
     * it is kept because the caller still uses it to decide how far to hold
     * the settled colour down toward the canvas.
     */
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
    //
    // Held down, not erased. These were 0.4/0.55, tuned against the old
    // hairline glyph where the rail's presence came mostly from its colour;
    // against a solid quarter block the same values read as washed out rather
    // than calm. The live rail is still the brightest thing in the column.
    return {
        color: bg ? mix(bg, settled, state.expanded ? 0.7 : 0.55) : settled,
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

    const glyph = RAIL;
    const tick = animTick();
    return lines.map((line, row) => {
        let color = spec.color;
        if (spec.motion === "wave") color = accentAtBrightness(bg, spec.color, waveBrightness(row, tick));
        else if (spec.motion === "pulse") color = accentAtBrightness(bg, spec.color, pulseBrightness(tick), 0.3);
        return verticalRule(color, glyph) + "  " + line;
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
