import { matchesKey } from "@notshekhar/loop-tui";

export const CTRL_C = "\x03";
export const CTRL_D = "\x04";
export const ESC = "\x1b";

export const isCtrlC = (d: string) => d === CTRL_C || matchesKey(d, "ctrl+c");
export const isCtrlD = (d: string) => d === CTRL_D || matchesKey(d, "ctrl+d");
export const isCtrlL = (d: string) => d === "\x0c" || matchesKey(d, "ctrl+l");
export const isCtrlE = (d: string) => d === "\x05" || matchesKey(d, "ctrl+e");
export const isCtrlV = (d: string) => d === "\x16" || matchesKey(d, "ctrl+v");
export const isCtrlG = (d: string) => d === "\x07" || matchesKey(d, "ctrl+g");
export const isCtrlP = (d: string) => d === "\x10" || matchesKey(d, "ctrl+p");
// NOTE: \x09 is TAB which legacy terminals share with Ctrl+I (i & 0x1f === 9),
// and matchesKey's legacy ctrl+letter branch treats them as the same byte.
// Exclude raw "\t" so only the Kitty-protocol Ctrl+I (a distinct CSI-u
// sequence) matches — otherwise plain Tab would fire the image picker instead
// of falling through to autocomplete.
export const isCtrlI = (d: string) => d !== "\t" && matchesKey(d, "ctrl+i");
export const isEsc = (d: string) => d === ESC || matchesKey(d, "escape");
// Block-selection navigation (chat history foldables). `\x1b[1;5A/B` are the
// classic xterm ctrl+arrow encodings; matchesKey covers Kitty-protocol forms.
export const isCtrlUp = (d: string) => d === "\x1b[1;5A" || matchesKey(d, "ctrl+up");
export const isCtrlDown = (d: string) => d === "\x1b[1;5B" || matchesKey(d, "ctrl+down");
// Turn jumps. `\x1b[1;3A/B` = xterm alt+arrow; `\x1b\x1b[A/B` = ESC-prefix
// terminals (Apple Terminal's default alt handling).
export const isAltUp = (d: string) => d === "\x1b[1;3A" || d === "\x1b\x1b[A" || matchesKey(d, "alt+up");
export const isAltDown = (d: string) => d === "\x1b[1;3B" || d === "\x1b\x1b[B" || matchesKey(d, "alt+down");
// Scrollback-focus navigation (plain keys — only read while focus mode is on).
export const isUp = (d: string) => d === "\x1b[A" || matchesKey(d, "up");
export const isDown = (d: string) => d === "\x1b[B" || matchesKey(d, "down");
export const isLeft = (d: string) => d === "\x1b[D" || matchesKey(d, "left");
export const isRight = (d: string) => d === "\x1b[C" || matchesKey(d, "right");
export const isShiftLeft = (d: string) => d === "\x1b[1;2D" || matchesKey(d, "shift+left");
export const isShiftRight = (d: string) => d === "\x1b[1;2C" || matchesKey(d, "shift+right");
export const isEnter = (d: string) => d === "\r" || d === "\n" || matchesKey(d, "enter");
/** A single printable character (letter-key auto-focus back to the prompt). */
export const isPrintableChar = (d: string) => d.length === 1 && d >= " " && d !== "\x7f";
// SGR mouse reports (CSI < b ; x ; y M/m) — only requested while nav mode is
// on. Wheel = button 64 (up) / 65 (down); modifier bits may be OR'd on top,
// so match on bit 64 plus the low direction bit. A single stdin chunk can
// carry several events (fast wheel), so scrolling counts every one.
export const MOUSE_SGR_ANY = /^\x1b\[<\d+;\d+;\d+[Mm]/;
const MOUSE_SGR_ALL = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
export function countWheelScroll(d: string): number {
    let delta = 0;
    for (const m of d.matchAll(MOUSE_SGR_ALL)) {
        const button = Number(m[1]);
        if (button & 64) delta += button & 1 ? 1 : -1;
    }
    return delta;
}
export const isPageUp = (d: string) => d === "\x1b[5~" || matchesKey(d, "pageUp");
export const isPageDown = (d: string) => d === "\x1b[6~" || matchesKey(d, "pageDown");
export const isHome = (d: string) => d === "\x1b[H" || d === "\x1b[1~" || matchesKey(d, "home");
export const isEnd = (d: string) => d === "\x1b[F" || d === "\x1b[4~" || matchesKey(d, "end");
export const isTab = (d: string) => d === "\t" || matchesKey(d, "tab");
export const isShiftTab = (d: string) => d === "\x1b[Z" || matchesKey(d, "shift+tab");
