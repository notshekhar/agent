import { describe, expect, test } from "bun:test";

import {
  buildAnnotationPayload,
  PICKER_SCRIPT,
  screenshotCropRect,
  type PickedGuestElement,
} from "./previewPicker";

const picked: PickedGuestElement = {
  pageUrl: "http://localhost:3000/pricing",
  pageTitle: "Pricing",
  tagName: "button",
  selector: "#buy",
  htmlPreview: "<button id=\"buy\">Buy</button>",
  componentName: "PricingCard",
  styles: "display: inline-flex;",
  rect: { x: 100, y: 50, width: 200, height: 40 },
  viewport: { width: 1200, height: 800 },
};

const viewport = picked.viewport;

describe("screenshotCropRect", () => {
  test("pads the element and stays inside the viewport", () => {
    expect(screenshotCropRect(picked.rect, 1, viewport)).toEqual({
      x: 92,
      y: 42,
      width: 216,
      height: 56,
    });
  });

  test("scales by the tab's zoom, because capturePage works in view pixels", () => {
    expect(screenshotCropRect(picked.rect, 2, viewport)).toEqual({
      x: 192,
      y: 92,
      width: 416,
      height: 96,
    });
  });

  test("clamps to the zoomed viewport, not the CSS one", () => {
    // Bottom-right corner of the page at 2x zoom: the crop has to stop at the
    // page's own edge (2400x1600 view pixels), which is what capturePage sees.
    const rect = { x: 1100, y: 760, width: 200, height: 60 };
    expect(screenshotCropRect(rect, 2, { width: 1200, height: 800 })).toEqual({
      x: 2192,
      y: 1512,
      width: 208,
      height: 88,
    });
  });

  test("clamps a rect that runs past the edge", () => {
    const crop = screenshotCropRect(
      { x: 1150, y: 780, width: 400, height: 400 },
      1,
      viewport,
    );
    expect(crop).toEqual({ x: 1142, y: 772, width: 58, height: 28 });
  });

  test("has no crop for an element scrolled out of view", () => {
    expect(screenshotCropRect({ x: -500, y: -500, width: 100, height: 100 }, 1, viewport)).toBeNull();
    expect(screenshotCropRect({ x: 10, y: 10, width: 0, height: 0 }, 1, viewport)).not.toBeNull();
  });

  test("treats a nonsense zoom as 1", () => {
    expect(screenshotCropRect(picked.rect, 0, viewport)).toEqual(
      screenshotCropRect(picked.rect, 1, viewport),
    );
  });
});

describe("buildAnnotationPayload", () => {
  test("carries the pick into the shape the composer renders", () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const payload = buildAnnotationPayload({
      picked,
      screenshot: {
        dataUrl: "data:image/png;base64,AAAA",
        width: 216,
        height: 56,
        cropRect: { x: 92, y: 42, width: 216, height: 56 },
      },
      now,
    });

    expect(payload.pageUrl).toBe(picked.pageUrl);
    expect(payload.pageTitle).toBe("Pricing");
    expect(payload.comment).toBe("");
    expect(payload.createdAt).toBe(now.toISOString());
    expect(payload.elements).toHaveLength(1);
    expect(payload.elements[0]?.element).toMatchObject({
      tagName: "button",
      selector: "#buy",
      componentName: "PricingCard",
      source: null,
      stack: [],
    });
    expect(payload.elements[0]?.rect).toEqual(picked.rect);
    expect(payload.regions).toEqual([]);
    expect(payload.strokes).toEqual([]);
    expect(payload.styleChanges).toEqual([]);
    expect(payload.screenshot?.dataUrl).toBe("data:image/png;base64,AAAA");
  });

  test("gives every pick its own id", () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const first = buildAnnotationPayload({ picked, screenshot: null, now });
    const second = buildAnnotationPayload({ picked, screenshot: null, now });

    expect(first.id).not.toBe(second.id);
    expect(first.elements[0]?.id).toBe(`${first.id}-element`);
  });
});

describe("PICKER_SCRIPT", () => {
  // It is injected as source, so a syntax error would only ever surface as a
  // silent cancel in the app.
  test("parses as an expression", () => {
    expect(() => new Function(`return ${PICKER_SCRIPT}`)).not.toThrow();
  });

  test("cleans up after itself so a page is never left armed", () => {
    expect(PICKER_SCRIPT).toContain("removeEventListener");
    expect(PICKER_SCRIPT).toContain("highlight.remove()");
  });

  // Verified against a page that opens a menu on mousedown and navigates on
  // click: with either one reaching the page, the host screenshots a page that
  // has already moved on, which reads as "it captured the wrong element".
  test("picks on the press and swallows the rest of the gesture", () => {
    expect(PICKER_SCRIPT).toContain('"pointerdown"');
    expect(PICKER_SCRIPT).toContain('"mouseup"');
    expect(PICKER_SCRIPT).toContain('"click"');
    expect(PICKER_SCRIPT).toContain('event.type !== "pointerdown" && event.type !== "mousedown"');
    expect(PICKER_SCRIPT).toContain("setTimeout(removePointerListeners");
  });

  test("lets the arrow keys widen the selection", () => {
    expect(PICKER_SCRIPT).toContain('event.key !== "ArrowUp" && event.key !== "ArrowDown"');
  });

  test("waits for a paint so its own highlight is not in the screenshot", () => {
    expect(PICKER_SCRIPT).toContain("requestAnimationFrame(() => requestAnimationFrame(settle))");
  });
});
