import {
  GHOSTTY_CELL_WIDE,
  ghosttyColorsEqual,
  type GhosttyCell,
  type GhosttyColor,
  type GhosttySnapshot,
} from "./core";

export interface GhosttyCellMetrics {
  readonly width: number;
  readonly height: number;
  readonly baseline: number;
}

const DEFAULT_SELECTION_BACKGROUND = "rgba(72, 122, 191, 0.35)";

/**
 * `cursorStyle` as libghostty reports it, named rather than compared as bare
 * integers at the point of use. Anything not listed draws a filled block,
 * which is the terminal default.
 */
const GHOSTTY_CURSOR_STYLE = {
  bar: 0,
  block: 1,
  underline: 2,
  blockHollow: 3,
} as const;

/** CSS pixels, before the device-grid snap. */
const CURSOR_BAR_WIDTH = 2;
const CURSOR_UNDERLINE_HEIGHT = 2;

/**
 * The canvas' device-pixel scale, taken from the transform actually in effect.
 *
 * Read rather than passed so it cannot drift from the `setTransform(ratio, …)`
 * the surface installs on resize. Guarded because the render tests drive this
 * with a hand-built context stub.
 */
function deviceScaleOf(context: CanvasRenderingContext2D): number {
  const scale = typeof context.getTransform === "function" ? context.getTransform().a : 1;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Put a CSS-pixel edge on a whole device pixel. */
function snapToDevice(value: number, scale: number): number {
  return Math.round(value * scale) / scale;
}

function cssColor(color: GhosttyColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function sameTextStyle(left: GhosttyCell, right: GhosttyCell): boolean {
  // Selection deliberately does not participate: it only tints the background
  // overlay, and splitting a text run at a selection boundary visibly shifts
  // glyph spacing whenever the face's true advance differs from the cell width.
  return (
    ghosttyColorsEqual(left.foreground, right.foreground) &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.invisible === right.invisible
  );
}

export function ghosttyTextRunEnd(
  cells: readonly GhosttyCell[],
  start: number,
  sameStyle: (cell: GhosttyCell) => boolean,
): number {
  let end = start + 1;
  while (end < cells.length) {
    const next = cells[end];
    if (!next) break;
    if (next.wide === GHOSTTY_CELL_WIDE.spacerTail) {
      end += 1;
      continue;
    }
    if (next.text.length === 0 || !sameStyle(next)) break;
    end += 1;
  }
  return end;
}

function fontForCell(cell: GhosttyCell, fontSize: number, fontFamily: string): string {
  const style = cell.italic ? "italic" : "normal";
  const weight = cell.bold ? "700" : "400";
  return `${style} ${weight} ${fontSize}px ${fontFamily}`;
}

export function measureGhosttyCell(
  context: CanvasRenderingContext2D,
  fontSize: number,
  fontFamily: string,
): GhosttyCellMetrics {
  context.font = `normal 400 ${fontSize}px ${fontFamily}`;
  const widthMeasurement = context.measureText("M");
  const verticalMeasurement = context.measureText("Mg");
  const ascent = verticalMeasurement.actualBoundingBoxAscent || fontSize;
  const descent = verticalMeasurement.actualBoundingBoxDescent;
  const glyphHeight = ascent + descent;
  const height = Math.max(1, Math.round(fontSize * 1.35), Math.ceil(glyphHeight));
  return {
    width: Math.max(1, widthMeasurement.width),
    height,
    baseline: Math.round((height - glyphHeight) / 2 + ascent),
  };
}

export function terminalGridSize(
  width: number,
  height: number,
  metrics: GhosttyCellMetrics,
  padding: number,
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor((width - padding * 2) / metrics.width)),
    rows: Math.max(1, Math.floor((height - padding * 2) / metrics.height)),
  };
}

export function renderGhosttySnapshot(options: {
  readonly context: CanvasRenderingContext2D;
  readonly snapshot: GhosttySnapshot;
  readonly metrics: GhosttyCellMetrics;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly padding: number;
  readonly forceFull: boolean;
  readonly cursorOn: boolean;
  readonly previousCursorY?: number | null;
  readonly focused?: boolean;
  readonly selectionBackground?: string;
  /** Vertical origin of row 0; defaults to the horizontal padding. */
  readonly originY?: number;
}): void {
  const {
    context,
    snapshot,
    metrics,
    fontSize,
    fontFamily,
    padding,
    forceFull,
    cursorOn,
    previousCursorY,
  } = options;
  const focused = options.focused ?? true;
  const selectionBackground = options.selectionBackground ?? DEFAULT_SELECTION_BACKGROUND;
  const originY = options.originY ?? padding;
  const rowsToDraw = forceFull
    ? Array.from({ length: snapshot.rows }, (_, index) => index)
    : [...snapshot.dirtyRows];
  if (
    previousCursorY !== null &&
    previousCursorY !== undefined &&
    previousCursorY >= 0 &&
    !rowsToDraw.includes(previousCursorY)
  ) {
    rowsToDraw.push(previousCursorY);
  }
  if (snapshot.cursorVisible && snapshot.cursorY >= 0 && !rowsToDraw.includes(snapshot.cursorY)) {
    rowsToDraw.push(snapshot.cursorY);
  }

  if (forceFull) {
    context.save();
    context.resetTransform();
    context.fillStyle = cssColor(snapshot.background);
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    context.restore();
  }

  context.textBaseline = "alphabetic";
  for (const rowIndex of rowsToDraw) {
    const row = snapshot.rowData[rowIndex];
    if (!row) continue;
    const top = originY + rowIndex * metrics.height;

    context.fillStyle = cssColor(snapshot.background);
    context.fillRect(padding, top, snapshot.cols * metrics.width, metrics.height);

    let backgroundStart = 0;
    while (backgroundStart < row.cells.length) {
      const first = row.cells[backgroundStart];
      if (!first) break;
      let backgroundEnd = backgroundStart + 1;
      while (backgroundEnd < row.cells.length) {
        const next = row.cells[backgroundEnd];
        if (
          !next ||
          next.selected !== first.selected ||
          !ghosttyColorsEqual(next.background, first.background)
        ) {
          break;
        }
        backgroundEnd += 1;
      }
      if (first.selected || !ghosttyColorsEqual(first.background, snapshot.background)) {
        const left = padding + backgroundStart * metrics.width;
        const width = (backgroundEnd - backgroundStart) * metrics.width;
        if (!ghosttyColorsEqual(first.background, snapshot.background)) {
          context.fillStyle = cssColor(first.background);
          context.fillRect(left, top, width, metrics.height);
        }
        if (first.selected) {
          context.fillStyle = selectionBackground;
          context.fillRect(left, top, width, metrics.height);
        }
      }
      backgroundStart = backgroundEnd;
    }

    let runStart = 0;
    while (runStart < row.cells.length) {
      const first = row.cells[runStart];
      if (!first) break;
      if (first.text.length === 0) {
        runStart += 1;
        continue;
      }
      const runEnd = ghosttyTextRunEnd(row.cells, runStart, (cell) => sameTextStyle(cell, first));
      const text = row.cells
        .slice(runStart, runEnd)
        .map((cell) => cell.text)
        .join("");
      if (!first.invisible && text.trim().length > 0) {
        context.save();
        context.beginPath();
        context.rect(
          padding + runStart * metrics.width,
          top,
          (runEnd - runStart) * metrics.width,
          metrics.height,
        );
        context.clip();
        context.font = fontForCell(first, fontSize, fontFamily);
        context.fillStyle = cssColor(first.foreground);
        context.fillText(
          text,
          padding + runStart * metrics.width,
          top + metrics.baseline,
          (runEnd - runStart) * metrics.width,
        );
        context.restore();
      }
      runStart = runEnd;
    }

    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      if (!cell || (!cell.underline && !cell.strikethrough && !cell.overline)) continue;
      context.fillStyle = cssColor(cell.foreground);
      const left = padding + column * metrics.width;
      if (cell.underline) context.fillRect(left, top + metrics.height - 2, metrics.width, 1);
      if (cell.strikethrough) {
        context.fillRect(left, top + Math.floor(metrics.height * 0.55), metrics.width, 1);
      }
      if (cell.overline) context.fillRect(left, top + 1, metrics.width, 1);
    }
  }

  if (cursorOn && snapshot.cursorVisible && snapshot.cursorX >= 0 && snapshot.cursorY >= 0) {
    // Snapped to the device-pixel grid, unlike everything above it.
    //
    // The context is scaled by devicePixelRatio and a cell is a FRACTIONAL
    // number of CSS pixels (7.2 at the default size), so filling the cursor at
    // its raw offset puts the block's edges mid-device-pixel and Chromium
    // anti-aliases them: MEASURED as one 48%-alpha column plus fourteen solid
    // ones, a soft edge that crawled from column to column as the cursor
    // advanced. Glyphs want that sub-pixel positioning — a solid rectangle is
    // exactly what does not.
    //
    // Both edges are snapped rather than an origin plus a width, so the block
    // stays flush with the next cell wherever the rounding lands.
    const scale = deviceScaleOf(context);
    const left = snapToDevice(padding + snapshot.cursorX * metrics.width, scale);
    const right = snapToDevice(padding + (snapshot.cursorX + 1) * metrics.width, scale);
    const top = snapToDevice(originY + snapshot.cursorY * metrics.height, scale);
    const bottom = snapToDevice(originY + (snapshot.cursorY + 1) * metrics.height, scale);
    const width = right - left;
    const height = bottom - top;
    // One device pixel, so the outline and the bar stay hairlines on a
    // retina panel instead of doubling with the ratio.
    const hairline = 1 / scale;
    const barWidth = Math.max(hairline, snapToDevice(CURSOR_BAR_WIDTH, scale));
    const underlineHeight = Math.max(hairline, snapToDevice(CURSOR_UNDERLINE_HEIGHT, scale));
    const strokeCursorOutline = () => {
      context.strokeStyle = cssColor(snapshot.cursor);
      if (typeof context.lineWidth === "number") context.lineWidth = hairline;
      // Stroke straddles the path, so the path sits half a device pixel inside
      // the block for the line to land on whole pixels.
      const inset = hairline / 2;
      context.strokeRect(left + inset, top + inset, width - hairline, height - hairline);
    };

    context.fillStyle = cssColor(snapshot.cursor);
    if (!focused) {
      // An unfocused terminal draws a hollow cursor so the active pane is obvious.
      strokeCursorOutline();
    } else if (snapshot.cursorStyle === GHOSTTY_CURSOR_STYLE.bar) {
      context.fillRect(left, top, barWidth, height);
    } else if (snapshot.cursorStyle === GHOSTTY_CURSOR_STYLE.underline) {
      context.fillRect(left, bottom - underlineHeight, width, underlineHeight);
    } else if (snapshot.cursorStyle === GHOSTTY_CURSOR_STYLE.blockHollow) {
      strokeCursorOutline();
    } else {
      context.fillRect(left, top, width, height);
      const cell = snapshot.rowData[snapshot.cursorY]?.cells[snapshot.cursorX];
      if (cell?.text) {
        context.font = fontForCell(cell, fontSize, fontFamily);
        context.fillStyle = cssColor(snapshot.background);
        // The BLOCK snaps to the pixel grid; the glyph inside it must not.
        // Text is positioned sub-pixel everywhere else, so snapping it here
        // would shift the character sideways the moment the cursor arrived on
        // it and shift it back when the cursor left.
        context.fillText(
          cell.text,
          padding + snapshot.cursorX * metrics.width,
          top + metrics.baseline,
          metrics.width,
        );
      }
    }
  }
}
