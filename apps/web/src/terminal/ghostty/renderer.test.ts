import { describe, expect, it } from "vite-plus/test";

import { GHOSTTY_CELL_WIDE, type GhosttyCell, type GhosttySnapshot } from "./core";
import {
  ghosttyTextRunEnd,
  measureGhosttyCell,
  renderGhosttySnapshot,
  terminalGridSize,
} from "./renderer";

const cell = (text: string, wide = 0): GhosttyCell => ({
  text,
  wide,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
});

describe("terminalGridSize", () => {
  it("matches the mobile renderer's cell-and-padding sizing model", () => {
    expect(terminalGridSize(808, 408, { width: 10, height: 20, baseline: 15 }, 4)).toEqual({
      cols: 80,
      rows: 20,
    });
  });

  it("never sends an invalid zero-sized terminal to libghostty", () => {
    expect(terminalGridSize(0, 0, { width: 10, height: 20, baseline: 15 }, 4)).toEqual({
      cols: 1,
      rows: 1,
    });
  });
});

describe("measureGhosttyCell", () => {
  it("uses descender-aware metrics and the mobile terminal line-height", () => {
    const measureText = (text: string) =>
      text === "M"
        ? { width: 7.2, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 0 }
        : { width: 14.4, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 };
    const context = {
      font: "",
      measureText,
    } as unknown as CanvasRenderingContext2D;

    expect(measureGhosttyCell(context, 12, "monospace")).toEqual({
      width: 7.2,
      height: 16,
      baseline: 11,
    });
  });
});

describe("ghosttyTextRunEnd", () => {
  it("includes wide spacer tails in the visual clip without rendering spaces", () => {
    const cells = [
      cell("界", GHOSTTY_CELL_WIDE.wide),
      cell("", GHOSTTY_CELL_WIDE.spacerTail),
      cell("🙂", GHOSTTY_CELL_WIDE.wide),
      cell("", GHOSTTY_CELL_WIDE.spacerTail),
      cell(""),
    ];
    expect(ghosttyTextRunEnd(cells, 0, () => true)).toBe(4);
  });
});

describe("renderGhosttySnapshot", () => {
  /**
   * A context stub that records cursor rectangles and reports a retina
   * transform, which is where the fractional-cell rounding actually bites.
   */
  const cursorRectContext = (scale: number) => {
    const fillRects: number[][] = [];
    const context = {
      canvas: { width: 400, height: 80 },
      beginPath: () => {},
      clip: () => {},
      fillRect: (...args: number[]) => fillRects.push(args),
      fillText: () => {},
      getTransform: () => ({ a: scale }),
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      strokeRect: () => {},
      lineWidth: 1,
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    return { context, fillRects };
  };

  const cursorSnapshot = (cursorX: number, cursorStyle: number): GhosttySnapshot => ({
    cols: 10,
    rows: 1,
    foreground: { r: 255, g: 255, b: 255 },
    background: { r: 0, g: 0, b: 0 },
    cursor: { r: 255, g: 255, b: 255 },
    cursorX,
    cursorY: 0,
    cursorVisible: true,
    cursorBlinking: false,
    cursorStyle,
    dirtyRows: new Set([0]),
    rowData: [
      {
        cells: Array.from({ length: 10 }, () => cell("")),
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      },
    ],
  });

  // A cell is 7.2 CSS px, so at devicePixelRatio 2 an unsnapped block lands on
  // half-device-pixels and Chromium anti-aliases its edge — the cursor rendered
  // as one translucent column plus fourteen solid ones, and the soft edge moved
  // between columns as the cursor advanced.
  it("puts the block cursor on whole device pixels at every column", () => {
    const metrics = { width: 7.2, height: 16, baseline: 11 };
    const scale = 2;
    for (const cursorX of [0, 1, 2, 3, 7]) {
      const { context, fillRects } = cursorRectContext(scale);
      renderGhosttySnapshot({
        context,
        snapshot: cursorSnapshot(cursorX, 1),
        metrics,
        fontSize: 12,
        fontFamily: "monospace",
        padding: 4,
        forceFull: false,
        cursorOn: true,
      });

      const [left = 0, top = 0, width = 0, height = 0] = fillRects.at(-1)!;
      for (const edge of [left, top, left + width, top + height]) {
        expect(Number.isInteger(edge * scale)).toBe(true);
      }
      // Still exactly one cell wide, to within the grid it was snapped onto.
      expect(Math.abs(width - metrics.width)).toBeLessThanOrEqual(1 / scale);
      expect(height).toBe(metrics.height);
    }
  });

  it("keeps the block flush with the following cell", () => {
    const metrics = { width: 7.2, height: 16, baseline: 11 };
    const rightEdgeOf = (cursorX: number) => {
      const { context, fillRects } = cursorRectContext(2);
      renderGhosttySnapshot({
        context,
        snapshot: cursorSnapshot(cursorX, 1),
        metrics,
        fontSize: 12,
        fontFamily: "monospace",
        padding: 4,
        forceFull: false,
        cursorOn: true,
      });
      const [left = 0, , width = 0] = fillRects.at(-1)!;
      return { left, right: left + width };
    };

    // No gap and no overlap between neighbours: snapping both edges rather
    // than an origin plus a width is what guarantees this.
    for (const cursorX of [0, 1, 2, 3]) {
      expect(rightEdgeOf(cursorX).right).toBeCloseTo(rightEdgeOf(cursorX + 1).left, 10);
    }
  });

  it("constrains text runs and cursor glyphs to their terminal cells", () => {
    const fillTextCalls: unknown[][] = [];
    const context = {
      canvas: { width: 200, height: 40 },
      beginPath: () => {},
      clip: () => {},
      fillRect: () => {},
      fillText: (...args: unknown[]) => fillTextCalls.push(args),
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const cells = [cell("a"), cell("b"), cell("x")];
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: 2,
      cursorY: 0,
      cursorVisible: true,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [{ cells, text: "abx", isWrapContinuation: false, wrapsToNext: false }],
    };

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 7.2, height: 16, baseline: 11 },
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: true,
    });

    expect(fillTextCalls).toEqual([
      ["abx", 4, 15, 21.6],
      ["x", 18.4, 15, 7.2],
    ]);
  });

  it("repaints the cell without an overlay during the blink off phase", () => {
    const fillTextCalls: unknown[][] = [];
    const context = {
      canvas: { width: 200, height: 40 },
      beginPath: () => {},
      clip: () => {},
      fillRect: () => {},
      fillText: (...args: unknown[]) => fillTextCalls.push(args),
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: 2,
      cursorY: 0,
      cursorVisible: true,
      cursorBlinking: true,
      cursorStyle: 1,
      dirtyRows: new Set(),
      rowData: [
        {
          cells: [cell("a"), cell("b"), cell("x")],
          text: "abx",
          isWrapContinuation: false,
          wrapsToNext: false,
        },
      ],
    };

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 7.2, height: 16, baseline: 11 },
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: false,
    });

    // The cursor row still repaints so the block disappears, but the inverted
    // glyph the on phase draws over the cell is gone.
    expect(fillTextCalls).toEqual([["abx", 4, 15, 21.6]]);
  });

  it("repaints the previous cursor row after the cursor moves", () => {
    const clearedRows: number[] = [];
    const context = {
      canvas: { width: 200, height: 80 },
      beginPath: () => {},
      clip: () => {},
      fillRect: (_left: number, top: number, _width: number, height: number) => {
        if (height === 16) clearedRows.push(top);
      },
      fillText: () => {},
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const snapshot: GhosttySnapshot = {
      cols: 1,
      rows: 3,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: 0,
      cursorY: 2,
      cursorVisible: true,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set(),
      rowData: [0, 1, 2].map(() => ({
        cells: [cell("")],
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      })),
    };

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 7.2, height: 16, baseline: 11 },
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: true,
      previousCursorY: 0,
    });

    expect(clearedRows).toEqual([4, 36, 36]);
  });
});
