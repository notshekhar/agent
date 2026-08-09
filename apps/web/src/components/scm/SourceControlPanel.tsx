import { ChevronDownIcon, ChevronRightIcon, MinusIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { GitStatus } from "../../loop/transport";
import { loopGit } from "../../loop/transport";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type ScmGroup,
  type ScmRow,
  canWriteIndex,
  conflictLabel,
  groupChanges,
  hasIndexView,
  partitionForDiscard,
} from "./scmGroups";

/**
 * Source control, in the shape a person who has used VS Code expects.
 *
 * Its own component rather than another mode inside `DiffPanel`: that file is
 * already past a thousand lines and its whole model is "one patch, two scopes",
 * where this is "many files, three groups, each with actions". Threading the
 * second through the first would make both harder to follow.
 *
 * The panel never predicts. Every action resolves with the repository's fresh
 * status and that is what repaints — staging one path can change another's
 * (a rename is two paths), and a guessed state that disagrees with git is worse
 * than the round trip costs.
 */

export interface SourceControlPanelProps {
  readonly cwd: string;
  readonly status: GitStatus | null;
  /** Called with the status git reported after a write, to update the caller. */
  readonly onStatusChange: (status: GitStatus) => void;
  /** Opens a file's diff for this side. */
  readonly onOpenFile?: (path: string, side: "staged" | "unstaged" | "merge") => void;
}

export function SourceControlPanel({
  cwd,
  status,
  onStatusChange,
  onOpenFile,
}: SourceControlPanelProps) {
  const git = loopGit();
  const groups = useMemo(() => groupChanges(status?.changes ?? []), [status?.changes]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** Blocks a second click while git is mid-write, per group. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const writable = canWriteIndex(git);

  const act = useCallback(
    async (key: string, work: () => Promise<GitStatus>) => {
      if (busy !== null) return;
      setBusy(key);
      setError(null);
      try {
        onStatusChange(await work());
      } catch (cause) {
        // Surfaced rather than swallowed: a stage that silently did nothing
        // leaves the panel showing a state the repository is not in.
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [busy, onStatusChange],
  );

  if (!hasIndexView(status)) return null;

  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-col text-sm">
      {error !== null && (
        <div className="mx-2 mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      {groups.length === 0 && (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          No changes in this repository.
        </p>
      )}

      {groups.map((group) => (
        <GroupSection
          key={group.id}
          group={group}
          cwd={cwd}
          collapsed={collapsed.has(group.id)}
          onToggle={() => toggle(group.id)}
          writable={writable}
          busy={busy}
          onAct={act}
          {...(onOpenFile === undefined ? {} : { onOpenFile })}
        />
      ))}
    </div>
  );
}

function GroupSection({
  group,
  cwd,
  collapsed,
  onToggle,
  writable,
  busy,
  onAct,
  onOpenFile,
}: {
  readonly group: ScmGroup;
  readonly cwd: string;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly writable: boolean;
  readonly busy: string | null;
  readonly onAct: (key: string, work: () => Promise<GitStatus>) => Promise<void>;
  readonly onOpenFile?: (path: string, side: "staged" | "unstaged" | "merge") => void;
}) {
  const git = loopGit();
  const paths = group.rows.map((row) => row.change.path);
  const disabled = busy !== null;

  /**
   * What the header button does for this group.
   *
   * Merge changes get neither: a conflicted file has to be resolved before it
   * can be staged, and offering "stage all" there would either fail or stage
   * files with conflict markers still in them.
   */
  const bulk =
    group.id === "staged"
      ? { icon: <MinusIcon className="size-3.5" />, label: "Unstage all", run: () => git!.unstage!(cwd, paths) }
      : group.id === "unstaged"
        ? { icon: <PlusIcon className="size-3.5" />, label: "Stage all", run: () => git!.stage!(cwd, paths) }
        : null;

  return (
    <section className="min-w-0">
      <header className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5 shrink-0" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{group.title}</span>
          <span className="ml-1 shrink-0 rounded bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
            {group.rows.length}
          </span>
        </button>
        {writable && bulk !== null && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onClick={() => void onAct(`${group.id}:all`, bulk.run)}
                  aria-label={bulk.label}
                >
                  {bulk.icon}
                </Button>
              }
            />
            <TooltipPopup>{bulk.label}</TooltipPopup>
          </Tooltip>
        )}
      </header>

      {!collapsed && (
        <ul className="min-w-0">
          {group.rows.map((row) => (
            <FileRow
              key={row.key}
              row={row}
              cwd={cwd}
              writable={writable}
              disabled={disabled}
              onAct={onAct}
              {...(onOpenFile === undefined ? {} : { onOpenFile })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function FileRow({
  row,
  cwd,
  writable,
  disabled,
  onAct,
  onOpenFile,
}: {
  readonly row: ScmRow;
  readonly cwd: string;
  readonly writable: boolean;
  readonly disabled: boolean;
  readonly onAct: (key: string, work: () => Promise<GitStatus>) => Promise<void>;
  readonly onOpenFile?: (path: string, side: "staged" | "unstaged" | "merge") => void;
}) {
  const git = loopGit();
  const { change } = row;
  const name = change.path.slice(change.path.lastIndexOf("/") + 1);
  const directory = change.path.slice(0, change.path.length - name.length).replace(/\/$/, "");

  return (
    <li className="group/row flex min-w-0 items-center gap-1 px-2 py-1 hover:bg-muted/50">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={() => onOpenFile?.(change.path, row.group)}
        title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
      >
        <span className="truncate">{name}</span>
        {directory !== "" && (
          <span className="truncate text-xs text-muted-foreground">{directory}</span>
        )}
        {change.conflict !== undefined && (
          <span className="shrink-0 text-xs text-amber-600 dark:text-amber-500">
            {conflictLabel(change.conflict)}
          </span>
        )}
        {(row.insertions > 0 || row.deletions > 0) && (
          <span className="ml-auto shrink-0 text-xs tabular-nums">
            {row.insertions > 0 && <span className="text-emerald-600">+{row.insertions}</span>}
            {row.deletions > 0 && <span className="ml-1 text-rose-600">-{row.deletions}</span>}
          </span>
        )}
      </button>

      {writable && row.group !== "merge" && (
        <span className="flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
          {row.group === "unstaged" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    aria-label={`Discard changes in ${name}`}
                    onClick={() => {
                      // Unrecoverable — git keeps no copy of a discarded
                      // working-tree edit — so this is the one action that asks.
                      const ok = window.confirm(
                        `Discard changes in ${name}? This cannot be undone.`,
                      );
                      if (!ok) return;
                      const { tracked, untracked } = partitionForDiscard([row]);
                      void onAct(`discard:${change.path}`, () =>
                        git!.discard!(cwd, { tracked, untracked }),
                      );
                    }}
                  >
                    <Undo2Icon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup>Discard changes</TooltipPopup>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label={
                    row.group === "staged" ? `Unstage ${name}` : `Stage ${name}`
                  }
                  onClick={() =>
                    void onAct(`${row.group}:${change.path}`, () =>
                      row.group === "staged"
                        ? git!.unstage!(cwd, [change.path])
                        : git!.stage!(cwd, [change.path]),
                    )
                  }
                >
                  {row.group === "staged" ? (
                    <MinusIcon className="size-3.5" />
                  ) : (
                    <PlusIcon className="size-3.5" />
                  )}
                </Button>
              }
            />
            <TooltipPopup>{row.group === "staged" ? "Unstage" : "Stage"}</TooltipPopup>
          </Tooltip>
        </span>
      )}
    </li>
  );
}
