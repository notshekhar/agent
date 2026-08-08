/**
 * A reasoning block, as a web row.
 *
 * The terminal gives thinking its own foldable line — `◆ Thinking…` with a
 * short live tail, collapsing to `◆ Thought for 1.2s`. The duration is the
 * point: it is the only feedback that a long silent pause was the model
 * working. That is kept; the glyph is not.
 *
 * The body is prose, not code, so it is set in the UI font — the one place
 * where copying the terminal's monospace would actively hurt readability.
 *
 * A replayed session has no duration (loop's transcript records the text, not
 * the timing), so the row reads plain "Thought" — as the terminal does too.
 */
import { BrainIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { memo, useState, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { formatDuration } from "./loopToolSummary";
import type { LoopThinkingEntry } from "./loopEntry";

/** Live tail while it streams — the terminal's `thinking.liveTailLines`. */
const LIVE_TAIL_LINES = 3;

export const LoopThinkingRow = memo(function LoopThinkingRow({
  thinking,
}: {
  thinking: LoopThinkingEntry;
}) {
  const [expanded, setExpanded] = useState(false);

  const label =
    thinking.durationMs !== undefined
      ? `Thought for ${formatDuration(thinking.durationMs)}`
      : thinking.streaming
        ? "Thinking…"
        : "Thought";

  const lines = thinking.text.split("\n");
  // Streaming shows a short tail so the row cannot grow without bound; once it
  // settles the body folds away and expands on click.
  const body = expanded ? lines : thinking.streaming ? lines.slice(-LIVE_TAIL_LINES) : [];
  const toggle = () => setExpanded((value) => !value);

  return (
    <div className="py-px">
      <div
        aria-expanded={expanded}
        className="group flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        onClick={toggle}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <BrainIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            thinking.streaming ? "animate-pulse text-foreground/60" : "text-muted-foreground/60",
          )}
        />
        <span
          className={cn(
            "text-[13px]",
            thinking.streaming ? "text-foreground/75" : "text-muted-foreground/80",
          )}
        >
          {label}
        </span>
        <span className="min-w-0 flex-1" />
        {expanded ? (
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/45" />
        ) : (
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/45" />
        )}
      </div>
      {body.length > 0 ? (
        <div className="mt-1 ml-[22px] border-border/60 border-l-2 pl-3">
          <p className="whitespace-pre-wrap break-words text-[12.5px] text-muted-foreground italic leading-relaxed">
            {body.join("\n")}
          </p>
        </div>
      ) : null}
    </div>
  );
});
