"use client";

import { Globe, History } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";

import type { PreviewUrlSuggestion } from "./previewUrlHistory";

interface Props {
  readonly suggestions: ReadonlyArray<PreviewUrlSuggestion>;
  readonly activeIndex: number;
  /** The address bar itself; the list is measured and anchored to it. */
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly listId: string;
  readonly optionId: (index: number) => string;
  readonly onSelect: (suggestion: PreviewUrlSuggestion) => void;
  readonly onHighlight: (index: number) => void;
}

interface AnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/**
 * The webview sits in a `position: fixed` layer of its own, so the list is
 * portalled to the body and anchored by measurement rather than nested in the
 * chrome row, where an ancestor's overflow could clip it.
 */
function useAnchorRect(anchorRef: React.RefObject<HTMLElement | null>): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);

  useLayoutEffect(() => {
    const element = anchorRef.current;
    if (!element) return;
    const measure = () => {
      const measured = element.getBoundingClientRect();
      setRect((current) =>
        current &&
        current.left === measured.left &&
        current.top === measured.bottom &&
        current.width === measured.width
          ? current
          : { left: measured.left, top: measured.bottom, width: measured.width },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    // Panel drags move the bar without resizing it, so re-measure on scroll of
    // any ancestor too — capture phase catches scrolls we don't own.
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorRef]);

  return rect;
}

function SuggestionLabel({ suggestion }: { readonly suggestion: PreviewUrlSuggestion }) {
  const { match, typed } = suggestion;
  if (!match) return <span className="truncate">{typed}</span>;
  return (
    <span className="truncate">
      {typed.slice(0, match.start)}
      <span className="font-medium text-foreground">{typed.slice(match.start, match.end)}</span>
      {typed.slice(match.end)}
    </span>
  );
}

export function PreviewUrlSuggestions({
  suggestions,
  activeIndex,
  anchorRef,
  listId,
  optionId,
  onSelect,
  onHighlight,
}: Props) {
  const rect = useAnchorRect(anchorRef);
  if (typeof document === "undefined" || rect === null || suggestions.length === 0) return null;

  return createPortal(
    <ul
      id={listId}
      role="listbox"
      aria-label="Address suggestions"
      className="fixed z-50 max-h-80 overflow-y-auto overscroll-contain rounded-lg border bg-popover p-1 text-sm shadow-lg/5"
      style={{ left: rect.left, top: rect.top + 4, width: rect.width }}
      // Keep focus in the address bar: a blur would close the list before the
      // click could land on a row.
      onMouseDown={(event) => event.preventDefault()}
    >
      {suggestions.map((suggestion, index) => (
        <li
          key={suggestion.url}
          id={optionId(index)}
          role="option"
          aria-selected={index === activeIndex}
          className={cn(
            "flex min-h-7 cursor-default items-center gap-2 rounded-sm px-2 py-1 text-muted-foreground",
            index === activeIndex && "bg-accent text-accent-foreground",
          )}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onSelect(suggestion)}
        >
          {suggestion.visits > 1 ? (
            <History className="size-3.5 shrink-0 opacity-70" />
          ) : (
            <Globe className="size-3.5 shrink-0 opacity-70" />
          )}
          <SuggestionLabel suggestion={suggestion} />
          {suggestion.title ? (
            <span className="ml-auto min-w-0 shrink truncate text-xs opacity-70">
              {suggestion.title}
            </span>
          ) : null}
        </li>
      ))}
    </ul>,
    document.body,
  );
}
