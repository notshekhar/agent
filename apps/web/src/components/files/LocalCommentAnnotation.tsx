import { MessageCircle, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

/**
 * Put text selection back inside the comment card.
 *
 * `@pierre/diffs` injects a document-wide `[data-annotation-slot] { user-select:
 * none }` (dist/editor/editor.js) so dragging across a code row selects lines
 * rather than text — and every annotation this file renders is portaled into
 * one of those slots. Chromium does not paint a caret in a field it believes is
 * unselectable, so the comment box took typing while showing no cursor at all,
 * and a saved comment could not be selected or copied.
 */
const SELECTABLE = "select-text [-webkit-user-select:text]";

interface LocalCommentAnnotationProps {
  kind: "draft" | "comment";
  rangeLabel: string;
  text: string;
  onCancel: () => void;
  onComment: (text: string) => void;
  onDelete: () => void;
}

export function LocalCommentAnnotation({
  kind,
  rangeLabel,
  text: savedText,
  onCancel,
  onComment,
  onDelete,
}: LocalCommentAnnotationProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Take the caret, and take it back.
   *
   * MEASURED: after a real click on the gutter the comment box opened with
   * `document.activeElement` still on `body` — React's `autoFocus` ran, and
   * something after it took the focus away again. `@pierre/diffs` re-renders
   * the row the annotation is slotted into as part of opening it, and that
   * lands in a later frame than the mount. So the box looked normal, showed no
   * cursor, and swallowed every keystroke until it was clicked.
   *
   * Two attempts, a frame apart, and never over a focus the user has already
   * moved into the card itself — clicking Cancel must not be undone by the
   * second attempt.
   */
  useEffect(() => {
    if (kind !== "draft") return;
    let frame = 0;
    const claim = () => {
      const input = inputRef.current;
      if (!input) return;
      const active = document.activeElement;
      if (active !== null && input.closest("[data-file-comment-annotation]")?.contains(active)) {
        return;
      }
      input.focus();
    };
    claim();
    frame = requestAnimationFrame(claim);
    return () => cancelAnimationFrame(frame);
  }, [kind]);

  if (kind === "comment") {
    return (
      <div
        data-file-comment-annotation
        className={`mx-3 my-2 rounded-xl border border-border/70 bg-background p-3 shadow-sm ${SELECTABLE}`}
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <MessageCircle className="size-4 text-muted-foreground" />
          <span className="text-xs font-medium">Local comment</span>
          <span className="ml-auto text-[11px] text-muted-foreground">{rangeLabel}</span>
          <Button variant="ghost" size="icon-xs" aria-label="Delete comment" onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {savedText}
        </p>
      </div>
    );
  }

  return (
    <div
      data-file-comment-annotation
      className={`mx-3 my-2 rounded-xl border border-border/70 bg-background p-3 shadow-lg ${SELECTABLE}`}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <MessageCircle className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Local comment</span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">Comment on lines {rangeLabel}</div>
      <Textarea
        ref={inputRef}
        autoFocus
        className="mt-3"
        size="sm"
        value={text}
        placeholder="Request change"
        aria-label={`Comment on lines ${rangeLabel}`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && text.trim()) {
            event.preventDefault();
            onComment(text.trim());
          }
        }}
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!text.trim()} onClick={() => onComment(text.trim())}>
          Comment
        </Button>
      </div>
    </div>
  );
}
