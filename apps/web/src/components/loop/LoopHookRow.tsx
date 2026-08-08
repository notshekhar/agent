/**
 * A line a hook wrote.
 *
 * Hooks are the user's own scripts running on their own machine, and they
 * speak to the user rather than to the model — "prettier rewrote 3 files",
 * "blocked: main is protected". The terminal prints each into the transcript;
 * the app dropped the event, so a hook that rewrote or refused a tool call
 * left nothing on screen and the turn looked like it had simply misbehaved.
 *
 * Drawn as a small monospace note rather than a card: it is machine output,
 * and it is chrome around the work rather than the work itself.
 */
import { TerminalIcon } from "lucide-react";
import { memo } from "react";

import type { LoopHookEntry } from "./loopEntry";

export const LoopHookRow = memo(function LoopHookRow({ hook }: { hook: LoopHookEntry }) {
  const lines = hook.text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;

  return (
    <div className="flex items-baseline gap-2 py-px pl-1">
      <TerminalIcon aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground/45" />
      <div className="min-w-0 flex-1">
        {lines.map((line, index) => (
          // Hook output has no identity of its own; the index is the line.
          // eslint-disable-next-line react/no-array-index-key
          <p
            className="whitespace-pre-wrap break-words font-mono text-[11.5px] text-muted-foreground/65 leading-[1.55]"
            key={index}
          >
            {line}
          </p>
        ))}
      </div>
    </div>
  );
});
