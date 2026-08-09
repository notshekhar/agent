import { ChevronDownIcon, ChevronRightIcon, FolderIcon, ListIcon, MinusIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { GitStatus } from "../../loop/transport";
import { type ScmTreeNode, buildTree } from "./scmTree";

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
  /**
   * The patches the panel already has, so a row can show its hunks without
   * asking git again: `staged` is HEAD→index, `unstaged` is index→working tree.
   */
  readonly patches?: { readonly staged: string; readonly unstaged: string };
  /** The file whose diff is on screen, highlighted like an open editor tab. */
  readonly selectedPath?: string | null;
}

export function SourceControlPanel({
  cwd,
  status,
  onStatusChange,
  onOpenFile,
  patches,
  selectedPath,
}: SourceControlPanelProps) {
  const git = loopGit();
  const groups = useMemo(() => groupChanges(status?.changes ?? []), [status?.changes]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /**
   * A flat list of changed files by default.
   *
   * The folder tree was tried and taken back out: for a list of things you are
   * about to stage, the directory scaffolding is rows you have to expand past
   * rather than information — the file name and its status are what the list is
   * for. The tree stays available behind the toggle for a repository where the
   * paths genuinely disambiguate.
   */
  const [asTree, setAsTree] = useState(false);
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

      {groups.some((group) => group.rows.length > 0) && (
        <div className="flex items-center justify-end px-2 pt-1">
          <RowAction
            label={asTree ? "Show as list" : "Show as tree"}
            tooltip={asTree ? "View as list" : "View as tree"}
            disabled={false}
            onClick={() => setAsTree((current) => !current)}
          >
            {asTree ? <ListIcon className="size-3.5" /> : <FolderIcon className="size-3.5" />}
          </RowAction>
        </div>
      )}

      {groups.map((group) => (
        <GroupSection
          asTree={asTree}
          key={group.id}
          group={group}
          cwd={cwd}
          collapsed={collapsed.has(group.id)}
          onToggle={() => toggle(group.id)}
          writable={writable}
          busy={busy}
          onAct={act}
          {...(onOpenFile === undefined ? {} : { onOpenFile })}
          {...(patches === undefined ? {} : { patches })}
          selectedPath={selectedPath ?? null}
        />
      ))}
    </div>
  );
}

function GroupSection({
  asTree,
  selectedPath,
  group,
  cwd,
  collapsed,
  onToggle,
  writable,
  busy,
  onAct,
  onOpenFile,
  patches,
}: {
  readonly asTree: boolean;
  readonly selectedPath: string | null;
  readonly group: ScmGroup;
  readonly cwd: string;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly writable: boolean;
  readonly busy: string | null;
  readonly onAct: (key: string, work: () => Promise<GitStatus>) => Promise<void>;
  readonly onOpenFile?: (path: string, side: "staged" | "unstaged" | "merge") => void;
  readonly patches?: { readonly staged: string; readonly unstaged: string };
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
  /**
   * The whole-group actions, in the order VS Code puts them: the destructive
   * one first and furthest from the pointer's resting place, the routine one
   * last and nearest.
   *
   * Merge changes get none. A conflicted file has to be resolved before it can
   * be staged, and "discard all" over a half-finished merge would throw away
   * the resolution work rather than the changes.
   */
  const bulkActions: BulkAction[] =
    group.id === "staged"
      ? [
          {
            key: "unstage-all",
            icon: <MinusIcon className="size-3.5" />,
            label: "Unstage all changes",
            run: () => git!.unstage!(cwd, paths),
          },
        ]
      : group.id === "unstaged"
        ? [
            {
              key: "discard-all",
              icon: <Undo2Icon className="size-3.5" />,
              label: "Discard all changes",
              // Unrecoverable, and over every file at once — so it names the
              // count rather than asking a vague "are you sure".
              confirm: `Discard all changes in ${group.rows.length} file${group.rows.length === 1 ? "" : "s"}? This cannot be undone.`,
              run: () => {
                const { tracked, untracked } = partitionForDiscard(group.rows);
                return git!.discard!(cwd, { tracked, untracked });
              },
            },
            {
              key: "stage-all",
              icon: <PlusIcon className="size-3.5" />,
              label: "Stage all changes",
              run: () => git!.stage!(cwd, paths),
            },
          ]
        : [];

  return (
    <section className="min-w-0 border-b border-border/40 pb-1 last:border-b-0">
      {/*
        Sticky, so the group you are working in stays named while you scroll a
        long list — with a solid background, or rows would show through it.
      */}
      <header className="group/header sticky top-0 z-10 flex items-center gap-1 bg-background px-2 py-1">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            {group.title}
          </span>
          <span className="ml-1.5 shrink-0 rounded-full bg-muted px-1.5 text-[10px] leading-[1.15rem] font-medium text-muted-foreground tabular-nums">
            {group.rows.length}
          </span>
        </button>
        {/* Hidden until the header is hovered, matching the rows below it. */}
        {writable && bulkActions.length > 0 && (
          <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/header:opacity-100 focus-within:opacity-100">
            {bulkActions.map((action) => (
              <RowAction
                key={action.key}
                label={action.label}
                tooltip={action.label}
                disabled={disabled}
                onClick={() => {
                  if (action.confirm !== undefined && !window.confirm(action.confirm)) return;
                  void onAct(`${group.id}:${action.key}`, action.run);
                }}
              >
                {action.icon}
              </RowAction>
            ))}
          </span>
        )}
      </header>

      {!collapsed && (
        <ul className="min-w-0">
          {asTree ? (
            <TreeNodes
              nodes={buildTree(group.rows)}
              depth={0}
              selectedPath={selectedPath}
              cwd={cwd}
              writable={writable}
              disabled={disabled}
              onAct={onAct}
              {...(onOpenFile === undefined ? {} : { onOpenFile })}
            />
          ) : (
            group.rows.map((row) => (
              <FileRow
                key={row.key}
                row={row}
                selectedPath={selectedPath}
                cwd={cwd}
                writable={writable}
                disabled={disabled}
                onAct={onAct}
                {...(onOpenFile === undefined ? {} : { onOpenFile })}
              />
            ))
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * The folded tree, indented by depth.
 *
 * Directories are collapsible and carry the count of files beneath them, so a
 * folded `apps/web/src/components` row still says how much is in it. Each keeps
 * its own open state locally — the tree is rebuilt on every status poll, and
 * lifting the state would mean rebuilding it too.
 */
function TreeNodes({
  nodes,
  depth,
  selectedPath,
  cwd,
  writable,
  disabled,
  onAct,
  onOpenFile,
}: {
  readonly nodes: readonly ScmTreeNode[];
  readonly depth: number;
  readonly selectedPath: string | null;
  readonly cwd: string;
  readonly writable: boolean;
  readonly disabled: boolean;
  readonly onAct: (key: string, work: () => Promise<GitStatus>) => Promise<void>;
  readonly onOpenFile?: (path: string, side: "staged" | "unstaged" | "merge") => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "file" ? (
          <FileRow
            key={node.row.key}
            row={node.row}
            selectedPath={selectedPath}
            cwd={cwd}
            writable={writable}
            disabled={disabled}
            depth={depth}
            onAct={onAct}
            {...(onOpenFile === undefined ? {} : { onOpenFile })}
          />
        ) : (
          <DirectoryRow
            key={node.path}
            node={node}
            depth={depth}
            selectedPath={selectedPath}
            cwd={cwd}
            writable={writable}
            disabled={disabled}
            onAct={onAct}
            {...(onOpenFile === undefined ? {} : { onOpenFile })}
          />
        ),
      )}
    </>
  );
}

function DirectoryRow({
  node,
  depth,
  selectedPath,
  cwd,
  writable,
  disabled,
  onAct,
  onOpenFile,
}: {
  readonly node: Extract<ScmTreeNode, { kind: "directory" }>;
  readonly depth: number;
  readonly selectedPath: string | null;
  readonly cwd: string;
  readonly writable: boolean;
  readonly disabled: boolean;
  readonly onAct: (key: string, work: () => Promise<GitStatus>) => Promise<void>;
  readonly onOpenFile?: (path: string, side: "staged" | "unstaged" | "merge") => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <li>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex w-full min-w-0 items-center gap-1 py-[3px] pr-2 text-left text-[13px] hover:bg-accent/60"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {open ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-muted-foreground">{node.label}</span>
          <span className="ml-auto shrink-0 pr-1 text-[11px] text-muted-foreground/60 tabular-nums">
            {node.fileCount}
          </span>
        </button>
      </li>
      {open && (
        <TreeNodes
          nodes={node.children}
          depth={depth + 1}
          selectedPath={selectedPath}
          cwd={cwd}
          writable={writable}
          disabled={disabled}
          onAct={onAct}
          {...(onOpenFile === undefined ? {} : { onOpenFile })}
        />
      )}
    </>
  );
}

/** A whole-group action shown in its header. */
interface BulkAction {
  readonly key: string;
  readonly icon: React.ReactNode;
  readonly label: string;
  /** Present when the action destroys work and must be confirmed first. */
  readonly confirm?: string;
  readonly run: () => Promise<GitStatus>;
}

/** git's colours for a status letter, so the list reads at a glance. */
const LETTER_TONE: Record<string, string> = {
  M: "text-amber-700/80 dark:text-amber-500/70",
  A: "text-emerald-700/80 dark:text-emerald-500/70",
  D: "text-rose-700/80 dark:text-rose-500/70",
  R: "text-sky-700/80 dark:text-sky-500/70",
  C: "text-sky-700/80 dark:text-sky-500/70",
  U: "text-emerald-700/80 dark:text-emerald-500/70",
  "!": "text-amber-700/80 dark:text-amber-500/70",
};

/** An icon button that only exists while the row is hovered or focused. */
function RowAction({
  label,
  tooltip,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly tooltip: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            disabled={disabled}
            aria-label={label}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function FileRow({
  row,
  selectedPath,
  cwd,
  writable,
  disabled,
  depth,
  onAct,
  onOpenFile,
}: {
  readonly row: ScmRow;
  readonly selectedPath: string | null;
  readonly depth?: number;
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
    <li
      className={`group/row flex min-w-0 items-center gap-1 py-[3px] pr-2 text-[13px] ${
        selectedPath === row.change.path ? "bg-accent" : "hover:bg-accent/60"
      }`}
      style={{ paddingLeft: `${(depth ?? 0) * 12 + 8}px` }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={() => onOpenFile?.(change.path, row.group)}
        title={change.originalPath ? `${change.originalPath} \u2192 ${change.path}` : change.path}
      >
        {/*
          The name never truncates before the path does. A column of
          `applyLineC…` tells you nothing; a truncated directory still leaves
          the filename readable, which is what the row is for.
        */}
        <span className={`shrink-0 truncate ${LETTER_TONE[row.letter] ?? ""}`}>{name}</span>
        {depth === undefined && directory !== "" && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
            {directory}
          </span>
        )}
        {change.conflict !== undefined && (
          <span className="shrink-0 text-[11px] text-amber-700/80 dark:text-amber-500/70">
            {conflictLabel(change.conflict)}
          </span>
        )}
        {/*
          This side's own counts — the staged row shows what is going into the
          commit, the unstaged row shows what is not. An untracked file appears
          in no diff at all, so it says what it is instead of showing +0 -0.
        */}
        {change.untracked && row.insertions === 0 && row.deletions === 0 ? (
          <span className="ml-auto shrink-0 pr-1 text-[11px] text-muted-foreground/60">new</span>
        ) : row.insertions > 0 || row.deletions > 0 ? (
          <span className="ml-auto shrink-0 pr-1 text-right text-[11px] tabular-nums">
            {row.insertions > 0 && <span className="text-emerald-700/70 dark:text-emerald-500/60">+{row.insertions}</span>}
            {row.deletions > 0 && <span className="ml-1 text-rose-700/70 dark:text-rose-500/60">-{row.deletions}</span>}
          </span>
        ) : null}
      </button>

      {/*
        Actions sit where the status letter is and swap places with it on hover,
        which is what VS Code does: the row stays quiet until you are on it, and
        the controls never widen the row or push the filename around.
      */}
      <span className="relative flex h-5 w-[3.25rem] shrink-0 items-center justify-end">
        {writable && row.group !== "merge" && (
          <span className="absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
            {row.group === "unstaged" && (
              <RowAction
                label={`Discard changes in ${name}`}
                tooltip="Discard changes"
                disabled={disabled}
                onClick={() => {
                  // Unrecoverable: git keeps no copy of a discarded working-tree
                  // edit, so this is the one action that asks first.
                  if (!window.confirm(`Discard changes in ${name}? This cannot be undone.`)) return;
                  const { tracked, untracked } = partitionForDiscard([row]);
                  void onAct(`discard:${change.path}`, () => git!.discard!(cwd, { tracked, untracked }));
                }}
              >
                <Undo2Icon className="size-3.5" />
              </RowAction>
            )}
            <RowAction
              label={row.group === "staged" ? `Unstage ${name}` : `Stage ${name}`}
              tooltip={row.group === "staged" ? "Unstage" : "Stage"}
              disabled={disabled}
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
            </RowAction>
          </span>
        )}
        <span
          className={`pointer-events-none w-4 text-center font-mono text-[11px] transition-opacity group-hover/row:opacity-0 ${LETTER_TONE[row.letter] ?? "text-muted-foreground"}`}
          aria-hidden
        >
          {row.letter}
        </span>
      </span>
    </li>
  );
}
