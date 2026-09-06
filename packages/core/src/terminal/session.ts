/**
 * A terminal session: a pty, a terminal emulator interpreting its output, and a
 * `render(width)` that turns the resulting screen into lines loop can draw.
 *
 * The emulator is the part that is easy to underestimate. A shell does not emit
 * lines — it emits cursor moves, scroll regions and erases, so the only way to
 * know what is on screen is to interpret them. @xterm/headless is the same
 * engine VS Code's terminal uses, without the DOM.
 */
import { Terminal } from "@xterm/headless";
import { spawnPty, ptyAvailable, ptyUnavailableReason, type Pty } from "./pty";

export interface TerminalSessionOptions {
    cmd?: string;
    args?: string[];
    cwd?: string;
    rows?: number;
    cols?: number;
    /** Called when the child exits, so a panel can close or show a notice. */
    onExit?: (code: number) => void;
    /** Called when the screen changed and the UI should repaint. */
    onUpdate?: () => void;
    /**
     * Whether the panel currently has the keyboard. The cursor is only drawn
     * when it does — a second cursor sitting in an unfocused panel while you
     * type at the prompt is worse than none.
     */
    isFocused?: () => boolean;
}

export interface TerminalSession {
    /** Draw the current screen, padded/clipped to `rows` by the caller. */
    render(width: number): string[];
    /** Forward a key to the child. Returns true (a terminal consumes everything). */
    handleInput(data: string): boolean;
    write(data: string): void;
    resize(rows: number, cols: number): void;
    kill(): void;
    readonly exited: boolean;
}

/** The user's shell, or a sensible default. */
function defaultShell(): string {
    return process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
}

/** Rebuild an SGR prefix for a cell's colours and attributes. */
function sgrFor(cell: {
    isFgDefault(): boolean;
    isFgPalette(): boolean;
    isFgRGB(): boolean;
    getFgColor(): number;
    isBgDefault(): boolean;
    isBgPalette(): boolean;
    isBgRGB(): boolean;
    getBgColor(): number;
    isBold(): number;
    isDim(): number;
    isItalic(): number;
    isUnderline(): number;
    isInverse(): number;
}): string {
    const codes: string[] = [];
    if (cell.isBold()) codes.push("1");
    if (cell.isDim()) codes.push("2");
    if (cell.isItalic()) codes.push("3");
    if (cell.isUnderline()) codes.push("4");
    if (cell.isInverse()) codes.push("7");
    if (cell.isFgRGB()) {
        const c = cell.getFgColor();
        codes.push(`38;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
    } else if (cell.isFgPalette()) {
        codes.push(`38;5;${cell.getFgColor()}`);
    }
    if (cell.isBgRGB()) {
        const c = cell.getBgColor();
        codes.push(`48;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
    } else if (cell.isBgPalette()) {
        codes.push(`48;5;${cell.getBgColor()}`);
    }
    return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

export function createTerminalSession(options: TerminalSessionOptions = {}): TerminalSession {
    if (!ptyAvailable()) throw new Error(ptyUnavailableReason() ?? "no pty support on this platform");

    let rows = Math.max(1, options.rows ?? 12);
    let cols = Math.max(1, options.cols ?? 80);

    const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
    let pty: Pty | undefined = spawnPty({
        cmd: options.cmd ?? defaultShell(),
        args: options.args,
        cwd: options.cwd,
        rows,
        cols,
    });

    let dirty = true;
    /** Redrawn whenever the cursor moves or focus changes, not just on output. */
    let lastCursor = "";
    pty.onData((chunk) => {
        term.write(chunk, () => {
            dirty = true;
            options.onUpdate?.();
        });
    });
    pty.onExit((code) => options.onExit?.(code));

    /**
     * One frame of the screen, as ANSI lines.
     *
     * Cached: `render` is called on every repaint of the whole frame, while the
     * screen only changes when the child writes something. Rebuilding a
     * thousand cells' worth of escape sequences for an idle shell would be pure
     * waste.
     */
    let cache: string[] = [];

    function paint(): string[] {
        const buf = term.buffer.active;
        const out: string[] = [];
        // The emulator tracks where the child put its cursor; the panel has to
        // draw it, because loop's hardware cursor is opt-in (HARDWARE_CURSOR)
        // and every other component paints its own.
        const focused = options.isFocused?.() ?? true;
        const curX = buf.cursorX;
        const curY = buf.cursorY;
        // The viewport, not the scrollback: `baseY` is the first visible row.
        for (let y = 0; y < rows; y++) {
            const line = buf.getLine(buf.baseY + y);
            if (!line) {
                out.push("");
                continue;
            }
            let text = "";
            let sgr = "";
            for (let x = 0; x < cols; x++) {
                const cell = line.getCell(x);
                if (!cell) continue;
                const chars = cell.getChars();
                // A zero-width cell is the tail of a wide character already emitted.
                if (cell.getWidth() === 0) continue;
                const next = sgrFor(cell as never);
                if (next !== sgr) {
                    text += next === "" ? "\x1b[0m" : `\x1b[0m${next}`;
                    sgr = next;
                }
                const glyph = chars === "" ? " " : chars;
                // Reverse video is the block cursor: it inverts whatever colours
                // the cell already had, so it stays visible on any background.
                text += focused && y === curY && x === curX ? `\x1b[7m${glyph}\x1b[27m` : glyph;
            }
            out.push(sgr === "" ? text : `${text}\x1b[0m`);
        }
        return out;
    }

    return {
        render(width: number): string[] {
            // The panel's width is the authority: reflow the child to match, so
            // its own line wrapping lands where the panel's edge is.
            if (width > 0 && width !== cols) {
                cols = width;
                term.resize(cols, rows);
                pty?.resize(rows, cols);
                dirty = true;
            }
            // The cursor moves without any new output (a plain left-arrow), and
            // focus changes without the child doing anything at all, so neither
            // can be left to the write callback to notice.
            const cursorKey = `${term.buffer.active.cursorX},${term.buffer.active.cursorY},${options.isFocused?.() ?? true}`;
            if (cursorKey !== lastCursor) {
                lastCursor = cursorKey;
                dirty = true;
            }
            if (dirty) {
                cache = paint();
                dirty = false;
            }
            return cache;
        },
        handleInput(data: string): boolean {
            pty?.write(data);
            return true;
        },
        write(data: string) {
            pty?.write(data);
        },
        resize(r: number, c: number) {
            rows = Math.max(1, r);
            cols = Math.max(1, c);
            term.resize(cols, rows);
            pty?.resize(rows, cols);
            dirty = true;
        },
        kill() {
            pty?.kill();
            pty = undefined;
            try {
                term.dispose();
            } catch {
                // disposing twice is fine
            }
        },
        get exited() {
            return pty?.exited ?? true;
        },
    };
}

export { ptyAvailable, ptyUnavailableReason };
