/**
 * Themed text helpers — the colours the interactive UI reaches for outside a
 * component's own render code: system lines, command output, prompts, errors.
 *
 * These exist because `chalk.yellow` and friends paint the TERMINAL's ANSI
 * palette, which has nothing to do with the active theme. Anything coloured
 * that way ignored `/theme` and `/uimode` entirely and stayed on the terminal's
 * defaults — visibly wrong the moment a theme moved off them. Routing through
 * the theme's slots means one palette drives the whole app.
 *
 * Each helper falls back to its chalk equivalent when no theme is active yet,
 * so code shared with print mode and early startup keeps working.
 */
import chalk from "chalk";
import { theme, themeReady, type ThemeColor } from "./theme";

function slot(name: ThemeColor, fallback: (s: string) => string): (s: string) => string {
    return (s: string) => (themeReady() ? theme.fg(name, s) : fallback(s));
}

/** Secondary text: hints, counts, system lines. */
export const dim = slot("dim", chalk.dim);
/** Body-adjacent text that is not the primary content. */
export const muted = slot("muted", chalk.gray);
/** Primary text, at full strength. */
export const strong = slot("text", (s) => s);
/** Warnings and "you should look at this" notices. */
export const warn = slot("warning", chalk.yellow);
/** Failures. */
export const err = slot("error", chalk.red);
/** Confirmations and completions. */
export const ok = slot("success", chalk.green);
/** The brand colour: emphasis, selected values, command names. */
export const accent = slot("accent", chalk.cyan);

// Attribute + colour combinations used often enough to be worth naming, so
// call sites never reach back to chalk for the colour half.

/** Selector and overlay headings ("Settings", "Model · …"). */
export const accentTitle = (s: string): string => chalk.bold(accent(s));
/**
 * A heading inside command output — the `cost`, `doctor` and `Context usage`
 * lines that lead a block printed into the transcript.
 *
 * Rides the same slot markdown headings do, so a heading loop PRINTS and a
 * heading loop RENDERS are the same colour. These were `chalk.bold` alone,
 * which is bold in whatever the terminal's default foreground happens to be —
 * so `/cost` and `/steak` sat outside the theme entirely and stayed put when
 * `/theme` moved everything else.
 */
export const heading = (s: string): string => chalk.bold(headingInk(s));
const headingInk = slot("mdHeading", (s) => s);
/** Headings on surfaces that need caution (the bash-approval prompt). */
export const warnTitle = (s: string): string => chalk.bold(warn(s));
/** A cancelled todo: struck through and receded. */
export const dimStruck = (s: string): string => chalk.strikethrough(dim(s));
