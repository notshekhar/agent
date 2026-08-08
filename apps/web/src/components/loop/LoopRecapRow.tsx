/**
 * The post-turn recap, as a web note.
 *
 * loop writes a short "what just happened" after a turn that changed files,
 * and the terminal prints it dim under the response behind a `※ recap:` label.
 * It is not part of the conversation — it never enters the model's context —
 * so it reads as a margin note here too, not as another assistant message.
 *
 * Drawn as a marginal annotation rather than a card. A bordered box is the
 * app's vocabulary for things you can act on (plans, approvals, compaction),
 * and giving the recap one made it compete with the reply it annotates. A
 * hairline rule that fades out down the side says "aside" without adding
 * another rectangle to a column that already has several: the label sits in
 * the margin, and the text keeps the reply's own left edge.
 *
 * Absent when recaps are off, which is loop's default.
 */
import { memo } from "react";

import type { LoopRecapEntry } from "./loopEntry";

export const LoopRecapRow = memo(function LoopRecapRow({ recap }: { recap: LoopRecapEntry }) {
  const lines = recap.text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;

  return (
    <div className="relative my-2.5 py-0.5 pl-3.5">
      {/* Fades out rather than stopping square: an aside has no bottom edge. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-px bg-gradient-to-b from-border via-border to-transparent"
      />
      <p className="font-medium text-[10px] text-muted-foreground/55 uppercase leading-none tracking-[0.14em]">
        Recap
      </p>
      <div className="mt-2 space-y-1">
        {lines.map((line, index) => (
          // Recap lines are plain text with no identity; the index is the line.
          // eslint-disable-next-line react/no-array-index-key
          <p
            className="max-w-[68ch] text-[12.5px] text-muted-foreground/90 leading-[1.65] [text-wrap:pretty]"
            key={index}
          >
            {line}
          </p>
        ))}
      </div>
    </div>
  );
});
