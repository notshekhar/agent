import * as fs from "node:fs";
import * as path from "node:path";
import { deleteKittyImage, isImageLine } from "./terminal-image";
import { type TUI, TuiBase, type TuiStopOptions } from "./tui";
import { visibleWidth } from "./utils";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const MAX_RENDER_WRITE_CHARS = 1024 * 1024;

/**
 * Streams terminal output in 1 MiB chunks so a full render never forms one string large enough to exceed V8's limit.
 *
 * `append()` fills the current chunk and flushes it when full. Oversized input is split at chunk boundaries, preserving
 * surrogate pairs so each write remains valid UTF-16. Callers append synchronized-output begin/end sequences themselves;
 * the final `flush()` writes any remainder, including the end sequence.
 */
class BoundedTerminalWriter {
    private buffer = "";
    private writtenChars = 0;
    private readonly write: (data: string) => void;

    constructor(write: (data: string) => void) {
        this.write = write;
    }

    /**
     * Append terminal data, flushing full chunks as needed. Callers must call `flush()` after the final append.
     * @param value Terminal data to write in order; oversized values are split without splitting surrogate pairs.
     */
    append(value: string): void {
        let offset = 0;
        while (offset < value.length) {
            const capacity = MAX_RENDER_WRITE_CHARS - this.buffer.length;
            if (capacity === 0) {
                this.flush();
                continue;
            }

            let end = Math.min(value.length, offset + capacity);
            if (
                end < value.length &&
                value.charCodeAt(end - 1) >= 0xd800 &&
                value.charCodeAt(end - 1) <= 0xdbff &&
                value.charCodeAt(end) >= 0xdc00 &&
                value.charCodeAt(end) <= 0xdfff
            ) {
                end--;
            }
            if (end === offset) {
                this.flush();
                continue;
            }

            this.buffer += value.slice(offset, end);
            offset = end;
            if (this.buffer.length === MAX_RENDER_WRITE_CHARS) {
                this.flush();
            }
        }
    }

    /** Write the current chunk, if any, and retain only its character count for debug output. */
    flush(): void {
        if (!this.buffer) return;
        this.write(this.buffer);
        this.writtenChars += this.buffer.length;
        this.buffer = "";
    }

    get length(): number {
        return this.writtenChars + this.buffer.length;
    }
}

interface KittyImageHeader {
    ids: number[];
    rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
    const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
    if (sequenceStart === -1) return undefined;
    const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
    const paramsEnd = line.indexOf(";", paramsStart);
    if (paramsEnd === -1) return undefined;

    const ids: number[] = [];
    let rows = 1;
    for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
        const [key, value] = param.split("=", 2);
        if (value === undefined) continue;
        const numberValue = Number(value);
        if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
        if (key === "i") ids.push(numberValue);
        else if (key === "r") rows = numberValue;
    }
    return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
    return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
    return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
    return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
    previousLines: string[];
    previousWidth: number;
    previousHeight: number;
    cursorRow: number;
    hardwareCursorRow: number;
    maxLinesRendered: number;
    previousViewportTop: number;
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
    readonly mode = "regular" as const;
    private previousLines: string[] = [];
    private previousKittyImageIds = new Set<number>();
    private previousWidth = 0;
    private previousHeight = 0;
    private cursorRow = 0;
    private hardwareCursorRow = 0;
    private maxLinesRendered = 0;
    private previousViewportTop = 0;

    captureRenderState(): TuiMainScreenRenderState {
        return {
            previousLines: [...this.previousLines],
            previousWidth: this.previousWidth,
            previousHeight: this.previousHeight,
            cursorRow: this.cursorRow,
            hardwareCursorRow: this.hardwareCursorRow,
            maxLinesRendered: this.maxLinesRendered,
            previousViewportTop: this.previousViewportTop,
        };
    }

    restoreRenderState(state: TuiMainScreenRenderState): void {
        this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
        this.previousKittyImageIds = new Set();
        this.previousWidth = state.previousWidth;
        this.previousHeight = state.previousHeight;
        this.cursorRow = state.cursorRow;
        this.hardwareCursorRow = state.hardwareCursorRow;
        this.maxLinesRendered = state.maxLinesRendered;
        this.previousViewportTop = state.previousViewportTop;
    }

    protected override resetRenderState(): void {
        this.previousLines = [];
        this.previousWidth = -1;
        this.previousHeight = -1;
        this.cursorRow = 0;
        this.hardwareCursorRow = 0;
        this.maxLinesRendered = 0;
        this.previousViewportTop = 0;
    }

    protected override beforeTerminalStop(options: TuiStopOptions): void {
        if (options.preserveScreen || this.previousLines.length === 0) return;
        this.terminal.write(" ");
        const targetRow = this.previousLines.length;
        const lineDiff = targetRow - this.hardwareCursorRow;
        if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
        else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
        this.terminal.write("\r\n");
    }

    // ---- loop-local (keep across pi-mono syncs) ----
    // Upstream answers a change above the visible window with a full
    // redraw, which is correct on screen and costs the user their
    // scrollback. These two put the same screen up without that trade.
    /**
     * The frame grew or shrank above the visible window, and what the terminal
     * is actually showing is unchanged — only the line indices moved. Returns
     * that shift, or null when the window's content really did change.
     *
     * This is the common shape of a late startup notice (an MCP summary, a
     * hooks list) landing under the banner while the conversation below it is
     * long enough to have pushed the banner off the top of the screen: every
     * visible row still holds exactly what it held before.
     *
     * Only claimed when BOTH frames fill the screen. A frame shorter than the
     * terminal leaves rows loop never painted — whatever the shell left there —
     * and comparing those against blanks would call a window unchanged that
     * loop cannot actually vouch for.
     */
    private unchangedWindowShift(newLines: string[], height: number, prevViewportTop: number): number | null {
        if (newLines.length < height || this.previousLines.length < height) return null;
        const newTop = newLines.length - height;
        const shift = newTop - prevViewportTop;
        if (shift === 0) return null;
        for (let i = 0; i < height; i++) {
            if (newLines[newTop + i] !== this.previousLines[prevViewportTop + i]) return null;
        }
        return shift;
    }

    /**
     * Repaint the rows the terminal is showing, from the frame in memory.
     *
     * The alternative — clearing the screen and the scrollback and drawing
     * everything again — buys the same correct screen at the price of the
     * user's terminal history, which is never a trade worth making. The lines
     * that belong on screen are already in `newLines`; painting them where
     * they go is the whole job. Whatever is in the scrollback stays as it was
     * printed: it cannot be rewritten, only destroyed, so it is left alone.
     *
     * Left alone means exactly that, and it is the one rule this repaint has
     * to keep: a row that has scrolled off the top is COMMITTED. It cannot be
     * taken back, so painting the frame from a line above the window does not
     * move that content down — it prints a second copy of it under the copy
     * already in the history. A frame that shrinks by k asks for exactly that,
     * k lines of it, and a turn full of collapsing blocks asks over and over,
     * which is how a conversation ends up in the scrollback twice. So the
     * window starts at the committed floor at the earliest, and the rows the
     * frame gave up are cleared rather than filled from above it.
     *
     * Returns false when the frame cannot be shown from the floor down: the
     * change itself is above it, or the frame no longer reaches it at all. The
     * only way to paint those is to touch committed rows, so the caller falls
     * back to the redraw instead.
     */
    private repaintVisibleWindow(
        newLines: string[],
        width: number,
        height: number,
        prevViewportTop: number,
        hardwareCursorRow: number,
        cursorPos: { row: number; col: number } | null,
        firstChanged: number,
    ): boolean {
        const top = Math.max(prevViewportTop, Math.max(0, newLines.length - height));
        const lastRow = newLines.length - 1;
        if (lastRow < top) return false;
        // Rows the frame is too short to fill from the floor. While there are
        // none the window is bottom-anchored and every visible row is real
        // content, whatever changed above it. Once there are, anything that
        // changed above the floor has nowhere to be drawn — that one needs the
        // redraw.
        if (top + height > newLines.length && firstChanged < top) return false;
        let buffer = "\x1b[?2026h";
        // Up to the first visible row, wherever the cursor happens to be.
        const upFromCursor = hardwareCursorRow - prevViewportTop;
        if (upFromCursor > 0) buffer += `\x1b[${upFromCursor}A`;
        buffer += "\r";
        for (let i = 0; i < height; i++) {
            if (i > 0) buffer += "\r\n";
            buffer += "\x1b[2K" + (newLines[top + i] ?? "");
        }
        // The paint ends on the window's last row, which is past the frame's
        // last line whenever the frame no longer fills the window. Come back
        // up to it, so the row the renderer thinks it is on is the row it is
        // on.
        const overshoot = top + height - 1 - lastRow;
        if (overshoot > 0) buffer += `\x1b[${overshoot}A`;
        buffer += "\x1b[?2026l";
        this.terminal.write(buffer);
        this.cursorRow = lastRow;
        this.hardwareCursorRow = lastRow;
        this.previousViewportTop = top;
        this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
        this.positionHardwareCursor(cursorPos, newLines.length);
        this.previousLines = newLines;
        this.previousKittyImageIds = this.collectKittyImageIds(newLines);
        this.previousWidth = width;
        this.previousHeight = height;
        return true;
    }

    private collectKittyImageIds(lines: string[]): Set<number> {
        const ids = new Set<number>();
        for (const line of lines) {
            for (const id of extractKittyImageIds(line)) {
                ids.add(id);
            }
        }
        return ids;
    }

    private deleteKittyImages(ids: Iterable<number>): string {
        let buffer = "";
        for (const id of ids) {
            buffer += deleteKittyImage(id);
        }
        return buffer;
    }

    private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
        const rows = extractKittyImageRows(lines[index] ?? "");
        if (rows <= 1) return 1;

        const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
        let reservedRows = 1;
        while (reservedRows < maxRows) {
            const line = lines[index + reservedRows] ?? "";
            if (isImageLine(line) || visibleWidth(line) > 0) break;
            reservedRows++;
        }
        return reservedRows;
    }

    private expandChangedRangeForKittyImages(
        firstChanged: number,
        lastChanged: number,
        newLines: string[],
    ): { firstChanged: number; lastChanged: number } {
        let expandedFirstChanged = firstChanged;
        let expandedLastChanged = lastChanged;
        const expandForLines = (lines: string[]): void => {
            for (let i = 0; i < lines.length; i++) {
                if (extractKittyImageIds(lines[i]).length === 0) continue;
                const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
                if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
                    expandedFirstChanged = Math.min(expandedFirstChanged, i);
                    expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
                }
            }
        };

        expandForLines(this.previousLines);
        expandForLines(newLines);
        return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
    }

    private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
        if (firstChanged < 0 || lastChanged < firstChanged) return "";

        const ids = new Set<number>();
        const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
        for (let i = firstChanged; i <= maxLine; i++) {
            for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
                ids.add(id);
            }
        }

        return this.deleteKittyImages(ids);
    }

    protected doRender(): void {
        if (this.stopped) return;
        const width = this.terminal.columns;
        const height = this.terminal.rows;
        const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
        const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
        const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
        let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
        let viewportTop = prevViewportTop;
        let hardwareCursorRow = this.hardwareCursorRow;
        const computeLineDiff = (targetRow: number): number => {
            const currentScreenRow = hardwareCursorRow - prevViewportTop;
            const targetScreenRow = targetRow - viewportTop;
            return targetScreenRow - currentScreenRow;
        };

        // Render all components to get new lines
        this.frameId++;
        this.renderingFrame = true;
        let newLines: string[];
        try {
            newLines = this.render(width);
        } finally {
            this.renderingFrame = false;
        }

        // Before compositing: overlays pad the frame out to the terminal's
        // height, and where the frame really ends is what an overlay anchored
        // to it needs to know.
        this.contentHeight = newLines.length;

        // Composite overlays into the rendered lines (before differential compare)
        if (this.hasOverlayEntries) {
            newLines = this.compositeOverlays(newLines, width, height);
        }

        // Extract cursor position before applying line resets (marker must be found first)
        const cursorPos = this.extractCursorPosition(newLines, height);

        newLines = this.applyLineResets(newLines);

        // Helper to clear scrollback and viewport and render all new lines
        const fullRender = (clear: boolean): void => {
            this.fullRedrawCount += 1;
            const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
            output.append("\x1b[?2026h"); // Begin synchronized output
            if (clear) {
                output.append(this.deleteKittyImages(this.previousKittyImageIds));
                output.append("\x1b[2J\x1b[H\x1b[3J"); // Clear screen, home, then clear scrollback
            }
            for (let i = 0; i < newLines.length; i++) {
                if (i > 0) output.append("\r\n");
                const line = newLines[i];
                const isImage = isImageLine(line);
                const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
                if (imageReservedRows > 1 && imageReservedRows <= height) {
                    for (let row = 1; row < imageReservedRows; row++) {
                        output.append("\r\n");
                    }
                    output.append(`\x1b[${imageReservedRows - 1}A`);
                    output.append(line);
                    output.append(`\x1b[${imageReservedRows - 1}B`);
                    i += imageReservedRows - 1;
                    continue;
                }
                output.append(line);
            }
            output.append("\x1b[?2026l"); // End synchronized output
            output.flush();
            this.cursorRow = Math.max(0, newLines.length - 1);
            this.hardwareCursorRow = this.cursorRow;
            // Reset max lines when clearing, otherwise track growth
            if (clear) {
                this.maxLinesRendered = newLines.length;
            } else {
                this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
            }
            const bufferLength = Math.max(height, newLines.length);
            this.previousViewportTop = Math.max(0, bufferLength - height);
            this.positionHardwareCursor(cursorPos, newLines.length);
            this.previousLines = newLines;
            this.previousKittyImageIds = this.collectKittyImageIds(newLines);
            this.previousWidth = width;
            this.previousHeight = height;
        };

        const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
        const logRedraw = (reason: string): void => {
            if (!debugRedraw) return;
            const logPath = path.join(this.logDirectory, "render-debug.log");
            const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, msg);
        };

        // A rebuilt transcript was announced by the caller (see resetFrame).
        // Nothing here can distinguish it from a line inserted above the
        // window, and the two want opposite treatment, so it is a signal
        // rather than a detection.
        if (this.frameReset) {
            this.frameReset = false;
            if (this.previousLines.length > 0) {
                logRedraw("frame reset");
                fullRender(true);
                return;
            }
        }

        // First render - just output everything without clearing (assumes clean screen)
        if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
            logRedraw("first render");
            fullRender(false);
            return;
        }

        // Width changes always need a full re-render because wrapping changes.
        if (widthChanged) {
            logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
            fullRender(true);
            return;
        }

        // Height changes normally need a full re-render to keep the visible viewport aligned,
        // but Termux changes height when the software keyboard shows or hides.
        // In that environment, a full redraw causes the entire history to replay on every toggle.
        if (heightChanged && !isTermuxSession()) {
            logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
            fullRender(true);
            return;
        }

        // Content shrunk below the working area and no overlays - re-render to clear empty rows
        // (overlays need the padding, so only do this when no overlays are active)
        // Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
        if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
            logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
            fullRender(true);
            return;
        }

        // Find first and last changed lines
        let firstChanged = -1;
        let lastChanged = -1;
        const maxLines = Math.max(newLines.length, this.previousLines.length);
        for (let i = 0; i < maxLines; i++) {
            const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
            const newLine = i < newLines.length ? newLines[i] : "";

            if (oldLine !== newLine) {
                if (firstChanged === -1) {
                    firstChanged = i;
                }
                lastChanged = i;
            }
        }
        const appendedLines = newLines.length > this.previousLines.length;
        if (appendedLines) {
            if (firstChanged === -1) {
                firstChanged = this.previousLines.length;
            }
            lastChanged = newLines.length - 1;
        }
        if (firstChanged !== -1) {
            const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
            firstChanged = expandedRange.firstChanged;
            lastChanged = expandedRange.lastChanged;
        }
        const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

        // No changes - but still need to update hardware cursor position if it moved
        if (firstChanged === -1) {
            this.positionHardwareCursor(cursorPos, newLines.length);
            this.previousViewportTop = prevViewportTop;
            this.previousHeight = height;
            return;
        }

        // LOCAL CHANGE (keep across pi-mono syncs). A frame that shrinks — a
        // menu closing, a tool group collapsing, the editor going back to one
        // line — ends higher than it did, and the rows it gave up have to be
        // dealt with. Repainting the window from the frame in memory deals with
        // them without clearing the screen and the scrollback, which is what
        // the alternative costs.
        //
        // What it must not do is fill those rows from above the fold. The
        // window can only be pulled back down to the frame's last line by
        // printing lines that have already scrolled off, and a line that has
        // scrolled off is committed: printing it again does not move it, it
        // makes a second copy under the first. Every collapse in a turn asks
        // for a few more, which is how a conversation ends up in the scrollback
        // twice. So the repaint stops at the committed floor and the rows below
        // the frame's end are cleared — the prompt sits that many rows higher
        // until the next append fills them, and the history stays true.
        if (newLines.length < this.previousLines.length && newLines.length > height && !this.hasOverlayEntries) {
            if (
                this.repaintVisibleWindow(
                    newLines,
                    width,
                    height,
                    prevViewportTop,
                    hardwareCursorRow,
                    cursorPos,
                    firstChanged,
                )
            ) {
                return;
            }
        }

        // All changes are in deleted lines (nothing to render, just clear)
        if (firstChanged >= newLines.length) {
            if (this.previousLines.length > newLines.length) {
                const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
                output.append("\x1b[?2026h");
                output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
                // Move to end of new content (clamp to 0 for empty content)
                const targetRow = Math.max(0, newLines.length - 1);
                if (targetRow < prevViewportTop) {
                    logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
                    fullRender(true);
                    return;
                }
                const lineDiff = computeLineDiff(targetRow);
                if (lineDiff > 0) output.append(`\x1b[${lineDiff}B`);
                else if (lineDiff < 0) output.append(`\x1b[${-lineDiff}A`);
                output.append("\r");
                // Clear extra lines without scrolling
                const extraLines = this.previousLines.length - newLines.length;
                if (extraLines > height) {
                    logRedraw(`extraLines > height (${extraLines} > ${height})`);
                    fullRender(true);
                    return;
                }
                const clearStartOffset = newLines.length === 0 ? 0 : 1;
                if (extraLines > 0 && clearStartOffset > 0) {
                    output.append(`\x1b[${clearStartOffset}B`);
                }
                for (let i = 0; i < extraLines; i++) {
                    output.append("\r\x1b[2K");
                    if (i < extraLines - 1) output.append("\x1b[1B");
                }
                const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
                if (moveBack > 0) {
                    output.append(`\x1b[${moveBack}A`);
                }
                output.append("\x1b[?2026l");
                output.flush();
                this.cursorRow = targetRow;
                this.hardwareCursorRow = targetRow;
            }
            this.positionHardwareCursor(cursorPos, newLines.length);
            this.previousLines = newLines;
            this.previousKittyImageIds = this.collectKittyImageIds(newLines);
            this.previousWidth = width;
            this.previousHeight = height;
            this.previousViewportTop = prevViewportTop;
            return;
        }

        // Differential rendering can only touch what was actually visible.
        // If the first changed line is above the previous viewport, we need a full redraw.
        // LOCAL CHANGE (keep across pi-mono syncs). Differential rendering can
        // only touch what was actually visible, so a change above the window
        // cannot be patched in place. It does not follow that the screen has to
        // be thrown away. Three cases, and only the last pays the scrollback:
        //
        //  1. The window's content is untouched — something was inserted above
        //     it (a late MCP or hooks line landing under the banner while a
        //     long conversation holds the screen). Every visible row still says
        //     what it said, so the right amount of output is NONE: only the
        //     line bookkeeping moves.
        //  2. The window's content did change — repaint those rows from the
        //     frame in memory.
        //  3. Kitty images in play: they are addressed in rows the plain
        //     repaint does not account for, so those keep the full redraw.
        if (firstChanged < prevViewportTop) {
            const shift = this.unchangedWindowShift(newLines, height, prevViewportTop);
            if (shift !== null) {
                this.cursorRow = Math.max(0, newLines.length - 1);
                this.hardwareCursorRow = Math.max(
                    newLines.length - height,
                    Math.min(newLines.length - 1, hardwareCursorRow + shift),
                );
                this.previousViewportTop = prevViewportTop + shift;
                this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
                this.positionHardwareCursor(cursorPos, newLines.length);
                this.previousLines = newLines;
                this.previousKittyImageIds = this.collectKittyImageIds(newLines);
                this.previousWidth = width;
                this.previousHeight = height;
                return;
            }
            const hasImages = this.previousKittyImageIds.size > 0 || newLines.some((l) => isImageLine(l));
            if (
                newLines.length >= height &&
                !this.hasOverlayEntries &&
                !hasImages &&
                this.repaintVisibleWindow(
                    newLines,
                    width,
                    height,
                    prevViewportTop,
                    hardwareCursorRow,
                    cursorPos,
                    firstChanged,
                )
            ) {
                return;
            }
            logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
            fullRender(true);
            return;
        }

        // Render from first changed line to end
        // Keep updates wrapped in synchronized output while writing bounded chunks.
        const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
        output.append("\x1b[?2026h"); // Begin synchronized output
        output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
        const prevViewportBottom = prevViewportTop + height - 1;
        const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
        if (moveTargetRow > prevViewportBottom) {
            const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
            const moveToBottom = height - 1 - currentScreenRow;
            if (moveToBottom > 0) {
                output.append(`\x1b[${moveToBottom}B`);
            }
            const scroll = moveTargetRow - prevViewportBottom;
            output.append("\r\n".repeat(scroll));
            prevViewportTop += scroll;
            viewportTop += scroll;
            hardwareCursorRow = moveTargetRow;
        }

        // Move cursor to first changed line (use hardwareCursorRow for actual position)
        const lineDiff = computeLineDiff(moveTargetRow);
        if (lineDiff > 0) {
            output.append(`\x1b[${lineDiff}B`); // Move down
        } else if (lineDiff < 0) {
            output.append(`\x1b[${-lineDiff}A`); // Move up
        }

        output.append(appendStart ? "\r\n" : "\r"); // Move to column 0

        // Only render changed lines (firstChanged to lastChanged), not all lines to end
        // This reduces flicker when only a single line changes (e.g., spinner animation)
        const renderEnd = Math.min(lastChanged, newLines.length - 1);
        for (let i = firstChanged; i <= renderEnd; i++) {
            if (i > firstChanged) output.append("\r\n");
            const line = newLines[i];
            const isImage = isImageLine(line);
            const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
            if (imageReservedRows > 1) {
                const imageStartScreenRow = i - viewportTop;
                if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
                    logRedraw(
                        `kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
                    );
                    fullRender(true);
                    return;
                }

                output.append("\x1b[2K");
                for (let row = 1; row < imageReservedRows; row++) {
                    output.append("\r\n\x1b[2K");
                }
                output.append(`\x1b[${imageReservedRows - 1}A`);
                output.append(line);
                output.append(`\x1b[${imageReservedRows - 1}B`);
                i += imageReservedRows - 1;
                continue;
            }

            output.append("\x1b[2K"); // Clear current line
            if (!isImage && visibleWidth(line) > width) {
                // Log all lines to crash file for debugging
                const crashLogPath = path.join(this.logDirectory, "render-crash.log");
                const crashData = [
                    `Crash at ${new Date().toISOString()}`,
                    `Terminal width: ${width}`,
                    `Line ${i} visible width: ${visibleWidth(line)}`,
                    "",
                    "=== All rendered lines ===",
                    ...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
                    "",
                ].join("\n");
                fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
                fs.writeFileSync(crashLogPath, crashData);

                // Clean up terminal state before throwing
                this.stop();

                const errorMsg = [
                    `Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
                    "",
                    "This is likely caused by a custom TUI component not truncating its output.",
                    "Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
                    "",
                    `Debug log written to: ${crashLogPath}`,
                ].join("\n");
                throw new Error(errorMsg);
            }
            output.append(line);
        }

        // Track where cursor ended up after rendering
        let finalCursorRow = renderEnd;

        // If we had more lines before, clear them and move cursor back
        if (this.previousLines.length > newLines.length) {
            // Move to end of new content first if we stopped before it
            if (renderEnd < newLines.length - 1) {
                const moveDown = newLines.length - 1 - renderEnd;
                output.append(`\x1b[${moveDown}B`);
                finalCursorRow = newLines.length - 1;
            }
            const extraLines = this.previousLines.length - newLines.length;
            for (let i = newLines.length; i < this.previousLines.length; i++) {
                output.append("\r\n\x1b[2K");
            }
            // Move cursor back to end of new content
            output.append(`\x1b[${extraLines}A`);
        }

        output.append("\x1b[?2026l"); // End synchronized output

        if (process.env.PI_TUI_DEBUG === "1") {
            const debugDir = "/tmp/tui";
            fs.mkdirSync(debugDir, { recursive: true });
            const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
            const debugData = [
                `firstChanged: ${firstChanged}`,
                `viewportTop: ${viewportTop}`,
                `cursorRow: ${this.cursorRow}`,
                `height: ${height}`,
                `lineDiff: ${lineDiff}`,
                `hardwareCursorRow: ${hardwareCursorRow}`,
                `renderEnd: ${renderEnd}`,
                `finalCursorRow: ${finalCursorRow}`,
                `cursorPos: ${JSON.stringify(cursorPos)}`,
                `newLines.length: ${newLines.length}`,
                `previousLines.length: ${this.previousLines.length}`,
                "",
                "=== newLines ===",
                JSON.stringify(newLines, null, 2),
                "",
                "=== previousLines ===",
                JSON.stringify(this.previousLines, null, 2),
                "",
                "=== buffer ===",
                `[${output.length} chars written in bounded chunks]`,
            ].join("\n");
            fs.writeFileSync(debugPath, debugData);
        }

        output.flush();

        // Track cursor position for next render
        // cursorRow tracks end of content (for viewport calculation)
        // hardwareCursorRow tracks actual terminal cursor position (for movement)
        this.cursorRow = Math.max(0, newLines.length - 1);
        this.hardwareCursorRow = finalCursorRow;
        // Track terminal's working area (grows but doesn't shrink unless cleared)
        this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
        this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

        // Position hardware cursor for IME
        this.positionHardwareCursor(cursorPos, newLines.length);

        this.previousLines = newLines;
        this.previousKittyImageIds = this.collectKittyImageIds(newLines);
        this.previousWidth = width;
        this.previousHeight = height;
    }

    /**
     * Position the hardware cursor for IME candidate window.
     * @param cursorPos The cursor position extracted from rendered output, or null
     * @param totalLines Total number of rendered lines
     */
    private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
        if (!cursorPos || totalLines <= 0) {
            this.terminal.hideCursor();
            return;
        }

        // Clamp cursor position to valid range
        const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
        const targetCol = Math.max(0, cursorPos.col);

        // Move cursor from current position to target
        const rowDelta = targetRow - this.hardwareCursorRow;
        let buffer = "";
        if (rowDelta > 0) {
            buffer += `\x1b[${rowDelta}B`; // Move down
        } else if (rowDelta < 0) {
            buffer += `\x1b[${-rowDelta}A`; // Move up
        }
        // Move to absolute column (1-indexed)
        buffer += `\x1b[${targetCol + 1}G`;

        if (buffer) {
            this.terminal.write(buffer);
        }

        this.hardwareCursorRow = targetRow;
        if (this.getShowHardwareCursor()) {
            this.terminal.showCursor();
        } else {
            this.terminal.hideCursor();
        }
    }
}
