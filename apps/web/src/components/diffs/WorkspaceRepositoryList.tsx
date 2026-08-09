"use client";

import type { ReviewWorkspaceRepository } from "@loop/contracts";
import { ChevronRightIcon, FolderGitIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * What a folder of repositories shows instead of a diff.
 *
 * The first attempt concatenated every child's patch into one. For a real
 * workspace that was 34 repositories and 17k added lines: past the preview
 * cap, slow to parse, and unreadable. Nothing here costs a patch — the rows
 * come from `numstat` counts — and the diff for exactly one repository is
 * fetched when its row is opened.
 *
 * Changed repositories are already sorted to the top by the shell; the quiet
 * ones stay visible but recede, because "which of my services are dirty" is
 * the question this list exists to answer.
 */
export function WorkspaceRepositoryList(props: {
  readonly repositories: ReadonlyArray<ReviewWorkspaceRepository>;
  readonly onOpen: (path: string) => void;
}) {
  const { repositories, onOpen } = props;
  const changed = repositories.filter((repository) => repository.filesChanged > 0);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 border-b border-border/70 bg-background/95 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur">
        {changed.length > 0
          ? `${changed.length} of ${repositories.length} repositories have changes`
          : `${repositories.length} repositories, none with changes`}
      </div>
      <ul className="divide-y divide-border/50">
        {repositories.map((repository) => {
          const quiet = repository.filesChanged === 0;
          return (
            <li key={repository.path}>
              <button
                type="button"
                onClick={() => onOpen(repository.path)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-hidden",
                  quiet && "opacity-55",
                )}
              >
                <FolderGitIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{repository.path}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {repository.branch ?? "detached"}
                    {quiet ? " · no changes" : ` · ${fileCount(repository.filesChanged)}`}
                  </span>
                </span>
                {quiet ? null : (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums">
                    {repository.insertions > 0 ? (
                      <span className="text-success">+{repository.insertions}</span>
                    ) : null}
                    {repository.deletions > 0 ? (
                      <span className="ml-1.5 text-destructive">-{repository.deletions}</span>
                    ) : null}
                  </span>
                )}
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/70" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function fileCount(files: number): string {
  return files === 1 ? "1 file" : `${files} files`;
}
