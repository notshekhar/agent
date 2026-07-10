/**
 * Canvas wash — modes with `canvas.wash` set the terminal's default
 * background to the theme's bgBase via OSC 11, so the whole screen (not just
 * painted cells) matches the mode. One escape in, one escape out: OSC 111
 * restores the terminal's own background on exit or when the wash goes away.
 */
import { theme } from "./theme";
import { uiStyle } from "./ui-mode";

let washApplied = false;

/** Apply (or re-apply after a mode/theme change) the active mode's wash. */
export function applyCanvasWash(out: NodeJS.WriteStream = process.stdout): void {
    const raw = uiStyle().canvas.wash ? theme.raw("bgBase") : undefined;
    if (typeof raw === "string" && raw.startsWith("#")) {
        out.write(`\x1b]11;${raw}\x07`);
        washApplied = true;
    } else if (washApplied) {
        resetCanvasWash(out);
    }
}

/** Restore the terminal's own background (exit path — safe to call twice). */
export function resetCanvasWash(out: NodeJS.WriteStream = process.stdout): void {
    if (!washApplied) return;
    out.write("\x1b]111\x07");
    washApplied = false;
}
