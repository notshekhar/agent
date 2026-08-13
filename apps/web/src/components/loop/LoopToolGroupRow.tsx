/**
 * A run of finished tool calls, folded into one row.
 *
 * The terminal's live mode does the same fold with a `◈` and the same
 * vocabulary (see `loopVerbGroup.ts`), for the same reason: a turn that read
 * four files and listed two directories is six rows of noise between two things
 * you actually wanted to read. What the terminal needs a mode and an arrow key
 * for, this surface gets for free — the header is a button, and the calls are
 * right there under it when you want them.
 *
 * The failure count rides in the destructive colour rather than the muted one:
 * a fold that hides a failure has to say so, or folding becomes a way to lose
 * bad news.
 */
import { ChevronDownIcon, ChevronRightIcon, LayersIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";

export const LoopToolGroupRow = memo(function LoopToolGroupRow({
  label,
  failed,
  count,
  children,
}: {
  label: string;
  failed: number;
  count: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="py-px">
      <button
        aria-expanded={expanded}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left transition-colors",
          "hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <LayersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/55" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground/80">
          {label}
          {failed > 0 ? (
            <span className="text-destructive">
              {" · "}
              {failed} failed
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/45">
          {expanded ? null : (
            <span className="tabular-nums">
              {count} call{count === 1 ? "" : "s"}
            </span>
          )}
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5" />
          )}
        </span>
      </button>
      {/* Indented under the header, so an open group reads as its contents
          rather than as the rows around it having multiplied. */}
      {expanded ? <div className="ml-[10px] border-border/50 border-l pl-2">{children}</div> : null}
    </div>
  );
});
