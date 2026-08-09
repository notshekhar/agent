import { Undo2Icon } from "lucide-react";
import { useState } from "react";

import type { GitStatus } from "../../loop/transport";
import { loopGit } from "../../loop/transport";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Throw away one file's working-tree changes, from the diff's own file header.
 *
 * The source-control sidebar offers the same thing, but reverting a single file
 * is the commonest thing to want while reading a patch, and opening another
 * surface to do it is a detour.
 */
export function DiscardFileButton({
  cwd,
  path,
  status,
  onDiscarded,
}: {
  readonly cwd: string;
  readonly path: string;
  readonly status: GitStatus | null;
  readonly onDiscarded: (status: GitStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const git = loopGit();
  const change = status?.changes?.find((entry) => entry.path === path);

  // Nothing in the working tree to revert — a file that is only staged, or one
  // that this patch shows from a range rather than the tree.
  if (!change?.unstaged || typeof git?.discard !== "function") return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={busy}
            aria-label={`Discard changes in ${path}`}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden disabled:opacity-50"
            onClick={(event) => {
              event.stopPropagation();
              // Unrecoverable: git keeps no copy of a discarded working-tree
              // edit, so this is the one action here that asks first.
              const name = path.slice(path.lastIndexOf("/") + 1);
              if (!window.confirm(`Discard changes in ${name}? This cannot be undone.`)) return;
              setBusy(true);
              void git
                .discard!(cwd, change.untracked ? { untracked: [path] } : { tracked: [path] })
                .then(onDiscarded)
                .finally(() => setBusy(false));
            }}
          >
            <Undo2Icon className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup>Discard changes</TooltipPopup>
    </Tooltip>
  );
}
