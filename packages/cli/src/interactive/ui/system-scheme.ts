/**
 * Asking the terminal what it is — the machinery behind noir's `system` theme.
 *
 * Every other theme is a decision the user typed. `system` is the one that
 * refuses to be configured: it paints no canvas, so the terminal's own
 * background shows through, and its ink has to match a background loop does
 * not own and cannot see. So it asks, twice over:
 *
 *  1. OSC 11 — the background COLOUR. The authority: it is the surface we are
 *     drawing on, and it is what the palette is rebuilt against.
 *  2. `CSI ? 996 n` — the colour-scheme report. A fallback for polarity when
 *     no background is named, and the LIVE signal: with `?2031h` the terminal
 *     tells us to come back and re-measure whenever it flips.
 *
 * A terminal that answers neither keeps the dark set on its safe canvas (see
 * `systemPalette`) — legible on anything from pure black to a light-ish
 * `#2e2e2e`, which is what makes an unanswered probe a non-event rather than
 * an unreadable screen. Both queries are cheap and time-limited, and neither
 * is ever asked unless `system` is the active theme.
 */
import type { RgbColor, TUI } from "@notshekhar/loop-tui";
import { applyCanvasWash } from "./canvas-wash";
import { setNoirSystem, SYSTEM_THEME_NAME } from "./noir-mode";
import { initTheme, theme } from "./theme";

/**
 * How long a probe waits. Terminals that support these reports answer in
 * microseconds; the timeout only bounds the ones that will never answer, and
 * nothing is blocked on it — the startup probe runs in the background.
 */
const PROBE_TIMEOUT_MS = 250;

/** Rec.601 luma — the same weights `palette.ts` weighs a hex with. */
function isLight(rgb: RgbColor): boolean {
    return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 > 0.5;
}

function toHex(rgb: RgbColor): string {
    return `#${[rgb.r, rgb.g, rgb.b]
        .map((c) =>
            Math.max(0, Math.min(255, Math.round(c)))
                .toString(16)
                .padStart(2, "0"),
        )
        .join("")}`;
}

/** Is the theme that needs any of this the one currently rendering? */
export function systemThemeActive(): boolean {
    return theme.name === SYSTEM_THEME_NAME;
}

/**
 * Ask the terminal both questions; undefined when it tells us nothing.
 *
 * The BACKGROUND COLOUR decides, and the scheme report is the fallback — which
 * is the opposite of how it first looks, and the difference is a bug worth
 * remembering. `CSI ? 996 n` reports the user's colour-scheme PREFERENCE, and
 * on macOS that is the OS appearance: a light desktop running a dark-themed
 * terminal answers "light" perfectly correctly, and a theme that believed it
 * painted near-black text and a near-white input bar onto a dark screen.
 *
 * OSC 11 has no such gap — it is the colour of the surface we are actually
 * drawing on. So when both answer, the colour wins the polarity AND tunes the
 * palette; the report is what's left when a terminal won't name its background.
 * The report still earns its keep as the LIVE signal: `?2031h` notifications
 * fire on a flip, and each one sends us back here to re-measure.
 */
async function probe(tui: TUI): Promise<{ scheme: "dark" | "light"; canvas?: string } | undefined> {
    const reported = await tui.queryTerminalColorScheme({ timeoutMs: PROBE_TIMEOUT_MS });
    const bg = await tui.queryTerminalBackgroundColor({ timeoutMs: PROBE_TIMEOUT_MS });
    if (bg) return { scheme: isLight(bg) ? "light" : "dark", canvas: toHex(bg) };
    return reported ? { scheme: reported } : undefined;
}

/** Re-resolve `system` under the scheme just recorded and repaint. */
function repaint(tui: TUI): void {
    initTheme(SYSTEM_THEME_NAME);
    // `system` carries no canvas, so this is what hands a previous theme's
    // wash back to the terminal (OSC 111/110) rather than what applies one.
    applyCanvasWash();
    tui.invalidate();
    tui.requestRender(true);
}

/**
 * Ask once and adopt the answer. Resolves to whether anything changed, so a
 * caller mid-session knows whether it has to repaint; the startup call does
 * not care (it repaints only when the answer differs from the default).
 */
export async function syncSystemScheme(tui: TUI): Promise<boolean> {
    const answer = await probe(tui);
    if (!answer || !setNoirSystem(answer.scheme, answer.canvas)) return false;
    if (systemThemeActive()) repaint(tui);
    return true;
}

let watching = false;

/**
 * Follow the terminal from here on: turn on unsolicited colour-scheme reports
 * (`?2031h`) and repaint whenever one arrives. Subscribed once per process —
 * the listener costs nothing while another theme is active, and re-arming it
 * on every `/theme system` would stack duplicate repaints.
 */
export function watchSystemScheme(tui: TUI): void {
    if (watching) return;
    watching = true;
    tui.setTerminalColorSchemeNotifications(true);
    tui.onTerminalColorSchemeChange(() => {
        // The notification carries the new polarity but not the new background
        // colour — and the ramp is solved against that colour — so re-probe
        // rather than trusting the report alone. Records the answer either
        // way: switching to `system` later should land on what the terminal
        // already said, without a further probe.
        void syncSystemScheme(tui).catch(() => {});
    });
}

/**
 * The startup path: only pays the probe when `system` is what the user
 * actually starts in, and never blocks the first paint on a terminal that
 * won't answer.
 */
export function startSystemSchemeTracking(tui: TUI): void {
    if (!systemThemeActive()) return;
    watchSystemScheme(tui);
    void syncSystemScheme(tui).catch(() => {});
}
