import { useEffect, useRef } from "react";

import { useDocumentVisible } from "../hooks/useDocumentVisible";

/**
 * A label that keeps its own text current without re-rendering.
 *
 * Elapsed-time text has to change every second, and there is one of these per
 * running thread and per streaming turn — as React state that is a commit per
 * second per label, on surfaces (the sidebar, the timeline) whose rows are
 * expensive precisely because they are the ones on screen while work runs.
 * Writing `textContent` on a ref moves the update off React entirely: the tick
 * touches one text node and nothing re-renders.
 *
 * `render` must be stable — wrap it in `useCallback` keyed on whatever it
 * closes over, or the interval restarts on every render of the parent.
 */
export function SelfTickingLabel({
  render,
  className,
  intervalMs = 1_000,
}: {
  readonly render: (nowMs: number) => string;
  readonly className?: string;
  readonly intervalMs?: number;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  // A hidden window cannot show the change, and the effect re-runs on the way
  // back — which repaints the text before the first tick, so returning never
  // catches a stale value.
  const documentVisible = useDocumentVisible();

  useEffect(() => {
    if (!documentVisible) return;
    const updateText = () => {
      if (textRef.current) textRef.current.textContent = render(Date.now());
    };
    updateText();
    const id = window.setInterval(updateText, intervalMs);
    return () => window.clearInterval(id);
  }, [documentVisible, intervalMs, render]);

  // The first paint comes from render, so the label is never briefly empty.
  return (
    <span ref={textRef} className={className}>
      {render(Date.now())}
    </span>
  );
}
