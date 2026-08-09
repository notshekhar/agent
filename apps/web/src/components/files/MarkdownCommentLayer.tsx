"use client";

import { MessageCircle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  mergeMarkdownSourceRanges,
  resolveMarkdownSourceRange,
} from "~/markdown-source-lines";

import { formatFileCommentRange } from "./fileCommentAnnotations";
import { LocalCommentAnnotation } from "./LocalCommentAnnotation";

interface SourceRange {
  readonly startLine: number;
  readonly endLine: number;
}

interface Anchored {
  readonly range: SourceRange;
  /** The selection's end, in the layer's scrolled content coordinates. */
  readonly x: number;
  readonly y: number;
  /** Its top edge, for flipping the control above a selection near the fold. */
  readonly topY: number;
}

/** Breathing room between the floating control and the pane's edges. */
const FLOAT_MARGIN = 8;

/**
 * Commenting on markdown you are reading rather than editing.
 *
 * The source view gets this from the code editor: line gutters, a drag, and a
 * comment card in the row below. Rendered markdown has no gutter and no lines
 * — so the selection itself is the range. Each block carries the source lines
 * it came from (`rehypeMarkdownSourceLines`), the selection's two ends resolve
 * to blocks, and the union of the two is the range the comment is filed
 * against. The comment that comes out is the same shape the code view
 * produces, so it lands in the composer next to the others.
 *
 * Block granularity, not word: a selection inside one paragraph comments on
 * that paragraph. That is the honest resolution — the rendering does not know
 * where a word sits in the source, and a range that claimed to is worse than
 * one that rounds outward.
 *
 * The anchor is deliberately STICKY. Clicking the button collapses the
 * selection, and an earlier version re-read the selection on every pointerup
 * and threw the anchor away mid-click: the card unmounted before the click
 * landed, then reappeared on the next selection because `composing` had
 * already been set. So a reading is only taken from a gesture that started in
 * the prose, and the anchor survives until the comment is filed or dismissed.
 */
export function MarkdownCommentLayer(props: {
  readonly children: React.ReactNode;
  readonly onComment: (input: SourceRange & { text: string }) => void;
}) {
  const { children, onComment } = props;
  const layerRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const [anchored, setAnchored] = useState<Anchored | null>(null);
  const [composing, setComposing] = useState(false);

  /** True while the event is inside this layer's own button or card. */
  const isOwnControl = useCallback((node: EventTarget | null) => {
    return node instanceof Node && floatRef.current?.contains(node) === true;
  }, []);

  const readSelection = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const domRange = selection.getRangeAt(0);
    if (!layer.contains(domRange.commonAncestorContainer)) return;
    const range = mergeMarkdownSourceRanges(
      resolveMarkdownSourceRange(domRange.startContainer, layer),
      resolveMarkdownSourceRange(domRange.endContainer, layer),
    );
    if (!range) return;

    // The last rect, so the button sits at the end of the selection rather
    // than over the middle of a multi-line one.
    const rects = domRange.getClientRects();
    const last = rects.item(rects.length - 1) ?? domRange.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    const first = rects.item(0) ?? last;
    setAnchored({
      range,
      x: last.right - layerRect.left + layer.scrollLeft,
      y: last.bottom - layerRect.top + layer.scrollTop,
      topY: first.top - layerRect.top + layer.scrollTop,
    });
  }, []);

  const dismiss = useCallback(() => {
    setComposing(false);
    setAnchored(null);
  }, []);

  useEffect(() => {
    // A press in the prose starts a new gesture: whatever was anchored is
    // stale. A press on the button or inside the card is not — it is the user
    // acting on what is already anchored.
    const onPointerDown = (event: PointerEvent) => {
      if (isOwnControl(event.target)) return;
      setComposing(false);
      setAnchored(null);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (isOwnControl(event.target)) return;
      // After the browser has settled the selection this gesture produced.
      window.setTimeout(readSelection, 0);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (isOwnControl(event.target)) return;
      if (event.key === "Escape") {
        dismiss();
        return;
      }
      if (event.shiftKey) readSelection();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [dismiss, isOwnControl, readSelection]);

  /**
   * Keep the control on screen.
   *
   * It is positioned in the pane's scrolled content, so a selection that ends
   * near an edge would otherwise push it out of the visible box — off the
   * right on a long line, or below the fold on the last visible paragraph,
   * where it cannot be clicked without scrolling away from the selection.
   *
   * Measured rather than guessed: the pill's width is its label, and the card
   * is a different size again. When it will not fit below the selection it
   * flips above it, and either way it is clamped into the visible rect.
   */
  useLayoutEffect(() => {
    const layer = layerRef.current;
    const element = floatRef.current;
    if (!layer || !element || !anchored) return;

    // Cap before measuring: the card asks for 28rem, which a narrow pane
    // cannot give it, and an overflowing card cannot be clamped into view.
    element.style.maxWidth = `${Math.max(160, layer.clientWidth - FLOAT_MARGIN * 2)}px`;
    const { offsetWidth: width, offsetHeight: height } = element;
    const minLeft = layer.scrollLeft + FLOAT_MARGIN;
    const maxLeft = layer.scrollLeft + layer.clientWidth - width - FLOAT_MARGIN;
    const minTop = layer.scrollTop + FLOAT_MARGIN;
    const maxTop = layer.scrollTop + layer.clientHeight - height - FLOAT_MARGIN;

    // Right-aligned to where the selection ended, just under it.
    const left = anchored.x - width;
    const below = anchored.y + 6;
    const top = below > maxTop ? anchored.topY - height - 6 : below;

    const clamp = (value: number, low: number, high: number) =>
      Math.round(Math.min(Math.max(value, low), Math.max(low, high)));
    element.style.left = `${clamp(left, minLeft, maxLeft)}px`;
    element.style.top = `${clamp(top, minTop, maxTop)}px`;
  }, [anchored, composing]);

  return (
    <div ref={layerRef} className="relative min-h-0 flex-1 overflow-auto">
      {children}
      {anchored ? (
        <div ref={floatRef} className="absolute z-30" style={{ left: 0, top: 0 }}>
          {composing ? (
            <div className="w-112">
              <LocalCommentAnnotation
                kind="draft"
                rangeLabel={formatFileCommentRange(
                  anchored.range.startLine,
                  anchored.range.endLine,
                )}
                text=""
                onCancel={dismiss}
                onComment={(text) => {
                  onComment({ ...anchored.range, text });
                  dismiss();
                }}
                onDelete={dismiss}
              />
            </div>
          ) : (
            // An opaque shell under the button: the outline variant's hover is
            // `bg-accent/50`, and over prose a half-transparent hover let the
            // paragraph show straight through the pill.
            <div className="rounded-lg bg-background shadow-md">
              <Button
                size="sm"
                variant="outline"
                // Keep the highlight up while the card opens: the default
                // mousedown behaviour would collapse it under the pointer.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setComposing(true)}
              >
                <MessageCircle className="size-3.5" />
                Comment on{" "}
                {formatFileCommentRange(anchored.range.startLine, anchored.range.endLine)}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
