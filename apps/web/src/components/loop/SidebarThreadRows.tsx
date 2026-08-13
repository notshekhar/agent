/**
 * The row and the section header the `projects` and `focused` sidebars share.
 *
 * Written once because the two styles differ in how they GROUP threads, not in
 * how they draw one. A thread row says the same four things everywhere: what
 * state it is in, what it is called, which branch it is on, and when it last
 * moved.
 *
 * The status dot is the command palette's, via `resolveThreadStatusPill` — the
 * same colours for the same states, so a thread that reads amber in one place
 * never reads grey in another.
 */
import { ArchiveIcon, ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { memo } from "react";
import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { compactTimeLabel } from "./ProjectSidebar.logic";
import type { SidebarThreadRow as ThreadRowModel } from "./sidebarThreads.logic";

/**
 * The state dot.
 *
 * Always rendered, even for a thread with nothing to report — an empty slot
 * keeps every title on the same left edge, so a thread starting or finishing
 * does not shift the row under the cursor.
 */
export const ThreadStatusDot = memo(function ThreadStatusDot({
  row,
}: {
  row: ThreadRowModel;
}) {
  if (!row.status) {
    return <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-transparent" />;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={row.status.label}
            className={cn(
              "mt-[7px] size-1.5 shrink-0 rounded-full",
              row.status.dotClass,
              row.status.pulse && "animate-status-pulse",
            )}
          />
        }
      />
      <TooltipPopup side="right">{row.status.label}</TooltipPopup>
    </Tooltip>
  );
});

/**
 * One thread.
 *
 * Two lines, and the second one is why: `branch` and `worktreePath` are on
 * every thread and were shown on neither of loop's own sidebars, so two threads
 * on two branches of the same repo were indistinguishable. It collapses to one
 * line when a thread has no branch, rather than leaving an empty row half.
 */
export const SidebarThreadRow = memo(function SidebarThreadRow({
  row,
  active,
  indent = false,
  onContextMenu,
  onArchive,
}: {
  row: ThreadRowModel;
  active: boolean;
  indent?: boolean;
  onContextMenu?: (row: ThreadRowModel, position: { x: number; y: number }) => void;
  onArchive?: (row: ThreadRowModel) => void;
}) {
  const isWorktree = row.worktreePath !== null;
  return (
    <Link
      className={cn(
        "group/thread-row relative flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1 text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2",
        active && "bg-sidebar-row-selected",
        indent && "ml-3",
      )}
      data-active={active}
      onContextMenu={
        onContextMenu
          ? (event) => {
              // Preventing the default is what lets our own menu through.
              // loop's shell exposes `window.loop`, never `desktopBridge`, so
              // `api.contextMenu` takes the DOM fallback rather than Electron's
              // native menu — and Chromium's would otherwise open on top of it.
              event.preventDefault();
              event.stopPropagation();
              onContextMenu(row, { x: event.clientX, y: event.clientY });
            }
          : undefined
      }
      params={{ environmentId: row.environmentId, threadId: row.id }}
      to="/$environmentId/$threadId"
    >
      <ThreadStatusDot row={row} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-5">{row.title}</span>
        {row.branch ? (
          <span className="flex min-w-0 items-center gap-1 text-[10.5px] text-sidebar-muted-foreground/70">
            <GitBranchIcon aria-hidden className="size-2.5 shrink-0" />
            <span className="truncate font-mono">{row.branch}</span>
            {isWorktree ? (
              <span aria-label="Runs in a worktree" className="shrink-0 opacity-70">
                · wt
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "mt-0.5 shrink-0 text-[10px] text-sidebar-muted-foreground/55 tabular-nums",
          // Swapped for the archive button on hover rather than shoved aside
          // by it: a row that widens under the cursor makes the whole list
          // jump while you are reading it.
          onArchive && "group-hover/thread-row:invisible",
        )}
      >
        {compactTimeLabel(formatRelativeTimeLabel(row.updatedAt))}
      </span>
      {onArchive ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={`Archive ${row.title}`}
                className="absolute top-1 right-1.5 hidden size-5 cursor-pointer items-center justify-center text-sidebar-muted-foreground/70 hover:text-sidebar-foreground group-hover/thread-row:flex"
                onClick={(event) => {
                  // The row is a link; archiving from it must not also open it.
                  event.preventDefault();
                  event.stopPropagation();
                  onArchive(row);
                }}
                role="button"
                tabIndex={-1}
              />
            }
          >
            <ArchiveIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">Archive</TooltipPopup>
        </Tooltip>
      ) : null}
    </Link>
  );
});

/**
 * A section header: label, count, hairline, chevron.
 *
 * Reads as a divider carrying a number rather than another row competing with
 * the threads under it. `tone="alert"` is for "Needs you", the one section that
 * is allowed to shout — and it only ever renders when it has something in it.
 */
export const SidebarSectionHeader = memo(function SidebarSectionHeader({
  label,
  count,
  open,
  onToggle,
  tone = "quiet",
}: {
  label: string;
  count?: number;
  open?: boolean;
  onToggle?: () => void;
  tone?: "quiet" | "alert";
}) {
  const content = (
    <>
      <span
        className={cn(
          "font-medium text-[10.5px] uppercase tracking-[0.04em]",
          tone === "alert" ? "text-warning-foreground" : "text-sidebar-muted-foreground/55",
        )}
      >
        {label}
      </span>
      {count === undefined ? null : (
        <span className="text-[10.5px] text-sidebar-muted-foreground/55 tabular-nums">{count}</span>
      )}
      <span aria-hidden className="h-px flex-1 bg-sidebar-border/60" />
      {onToggle ? (
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 text-sidebar-muted-foreground/50 transition-transform",
            !open && "-rotate-90",
          )}
        />
      ) : null}
    </>
  );

  if (!onToggle) {
    return <div className="flex items-center gap-2 px-2 pt-3 pb-1">{content}</div>;
  }
  return (
    <button
      aria-expanded={open}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 pt-3 pb-1 text-left outline-hidden ring-ring focus-visible:ring-2"
      onClick={onToggle}
      type="button"
    >
      {content}
    </button>
  );
});
