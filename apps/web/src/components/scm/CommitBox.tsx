import { GitCommitIcon, Loader2Icon } from "lucide-react";
import { useCallback, useState } from "react";

import type { GitStatus } from "../../loop/transport";
import { loopGit } from "../../loop/transport";
import { Button } from "../ui/button";

/**
 * The commit message field and its actions, at the foot of the source-control
 * sidebar — where anyone who has used an editor's SCM view expects them.
 *
 * The work itself goes through the shell's existing stacked action, which is
 * what the header's commit button already drives: it knows about hooks, feature
 * branches and upstreams, and a second implementation would drift from it.
 */

export interface CommitBoxProps {
  readonly cwd: string;
  readonly status: GitStatus | null;
  /** Called with fresh status after a commit, so the lists empty immediately. */
  readonly onCommitted: (status: GitStatus) => void;
}

export function CommitBox({ cwd, status, onCommitted }: CommitBoxProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<null | "commit" | "commit_push">(null);
  const [error, setError] = useState<string | null>(null);

  const git = loopGit();
  const stagedCount = status?.stagedCount ?? 0;
  const unstagedCount = status?.unstagedCount ?? 0;
  /**
   * Nothing staged means nothing to commit.
   *
   * Deliberately not "commit everything if nothing is staged": that is the one
   * behaviour in this view that could include a file the user had explicitly
   * left out, and staging is right there.
   */
  const canCommit =
    typeof git?.runStackedAction === "function" && stagedCount > 0 && message.trim() !== "";

  const run = useCallback(
    async (action: "commit" | "commit_push") => {
      if (!canCommit || busy !== null) return;
      setBusy(action);
      setError(null);
      try {
        const result = await git!.runStackedAction!({
          // Identifies this run in the shell's progress stream, so two commits
          // started in quick succession cannot be confused for one another.
          actionId: `scm-${Date.now()}`,
          cwd,
          action,
          commitMessage: message.trim(),
        });
        if (!result.ok) {
          // git's own words — "pre-commit hook failed", "no upstream" — rather
          // than a wrapper's summary of them.
          setError(result.error);
          return;
        }
        setMessage("");
        if (git?.status) onCommitted(await git.status(cwd));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [busy, canCommit, cwd, git, message, onCommitted],
  );

  if (typeof git?.runStackedAction !== "function") return null;

  return (
    <div className="shrink-0 border-t border-border/60 p-2">
      {error !== null && (
        <p className="mb-1.5 max-h-24 overflow-y-auto rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] whitespace-pre-wrap text-destructive">
          {error}
        </p>
      )}
      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          // Cmd/Ctrl+Enter commits, the shortcut every editor's message box has.
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void run("commit");
          }
        }}
        rows={2}
        placeholder={
          stagedCount > 0
            ? `Message (⌘Enter to commit ${stagedCount} file${stagedCount === 1 ? "" : "s"})`
            : "Stage changes to commit"
        }
        className="w-full resize-none rounded border border-border/60 bg-background px-2 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button
          size="sm"
          className="h-7 flex-1 text-xs"
          disabled={!canCommit || busy !== null}
          onClick={() => void run("commit")}
        >
          {busy === "commit" ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <GitCommitIcon className="size-3.5" />
          )}
          Commit
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-1 text-xs"
          disabled={!canCommit || busy !== null}
          onClick={() => void run("commit_push")}
        >
          {busy === "commit_push" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          Commit &amp; Push
        </Button>
      </div>
      {stagedCount === 0 && unstagedCount > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          Nothing staged. Stage a file to commit it.
        </p>
      )}
    </div>
  );
}
