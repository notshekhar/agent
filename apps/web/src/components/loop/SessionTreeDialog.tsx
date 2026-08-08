/**
 * The session tree — loop's `/tree`, in the app.
 *
 * A loop session is an append-only tree: rewinding to an earlier entry leaves
 * everything after it as a branch that no longer reaches the model but is
 * still there to come back to. `session.history` returns only the current
 * branch, so none of that was visible here — an earlier turn could be
 * revisited in the terminal and nowhere else.
 *
 * What the first attempt got wrong, and it is worth writing down: it indented
 * once per ancestor. A conversation is a chain with occasional detours, so
 * that turned an ordinary session into a diagonal staircase and communicated
 * nothing — every step of a single-child run is at the same place in the
 * story. loop now collapses those chains (`buildSessionTreeView`, the same
 * rule the TUI's `/tree` uses), so only real forks step in, and the active
 * branch sorts first among siblings.
 *
 * The filters are the other half. A 12-turn session is ~60 entries, most of
 * them tool calls and their results, and you navigate BY the prompts — an
 * unfiltered list is complete and unusable.
 *
 * Two actions, easy to confuse, so they are worded rather than iconified:
 *   Go here — moves THIS session's leaf; the branch below stops being what the
 *             model sees, and stays navigable.
 *   Fork    — copies the branch into a NEW session, leaving this one alone.
 */
import {
  CheckIcon,
  CornerUpLeftIcon,
  GitBranchIcon,
  MessageSquareIcon,
  ScissorsIcon,
  SearchIcon,
  SparklesIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import {
  branchSession,
  forkSession,
  readSessionTree,
  supportsSessionTree,
  type SessionTreeRow,
  type SessionTreeView,
} from "../../loop/tree";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { formatToolArgs } from "./loopToolSummary";
import {
  filterTreeRows,
  treeSummary,
  TREE_FILTER_MODES,
  type TreeFilterMode,
} from "./SessionTree.logic";

/** One indent step, in px. Small on purpose — forks are rare and shallow. */
const INDENT_STEP = 18;

/** What a row says it is, in one line. */
export function treeRowSummary(row: SessionTreeRow, cwd: string): string {
  if (row.type === "compact") return "context compacted";
  if (row.type === "branch-summary") return "branch summary";
  if (row.text) return `${row.text}${row.truncated ? "…" : ""}`;
  const tools = row.tools ?? [];
  if (tools.length > 0) {
    // The same grammar the transcript's tool rows use, so a row here and the
    // row it refers to describe the call identically.
    return tools
      .map((tool) => {
        const args =
          typeof tool.input === "object" && tool.input !== null && !Array.isArray(tool.input)
            ? (tool.input as Record<string, unknown>)
            : {};
        const summary = formatToolArgs(tool.name, args, cwd);
        return summary ? `${tool.name} ${summary}` : tool.name;
      })
      .join(", ");
  }
  // A message with neither text nor a call — an interrupted turn usually, or
  // one that produced only reasoning. Printing the raw entry type ("message")
  // says nothing the row's own metadata line does not already say better.
  if (row.type === "message") return row.interrupted ? "(cut off)" : "(no output)";
  return row.type;
}

function RowIcon({ row }: { row: SessionTreeRow }) {
  const className = "size-3.5 shrink-0";
  if (row.type === "compact") return <ScissorsIcon aria-hidden className={className} />;
  if (row.type === "branch-summary") return <SparklesIcon aria-hidden className={className} />;
  if (row.role === "user") return <UserIcon aria-hidden className={className} />;
  if (row.role === "tool") return <WrenchIcon aria-hidden className={className} />;
  return <MessageSquareIcon aria-hidden className={className} />;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export interface SessionTreeDialogProps {
  /** loop's session id. Null on a draft — there is no tree yet. */
  readonly sessionId: string | null;
  readonly cwd: string | null;
  /** A turn is in flight; loop refuses to move the leaf underneath it. */
  readonly running: boolean;
  /** Open a forked session. The fork is a different loop session, so the app
   * has to navigate to it — this component does not know how to route. */
  readonly onOpenSession: (sessionId: string, prompt?: string) => void | Promise<void>;
}

export const SessionTreeDialog = memo(function SessionTreeDialog({
  sessionId,
  cwd,
  running,
  onOpenSession,
}: SessionTreeDialogProps) {
  const [open, setOpen] = useState(false);
  // Undefined until loop has been asked. The control is absent, not disabled,
  // on a loop that cannot serve it — a button whose only outcome is "this loop
  // does not report a session tree" is worse than no button.
  const [supported, setSupported] = useState<boolean | undefined>(undefined);
  const [view, setView] = useState<SessionTreeView | null>(null);
  const [mode, setMode] = useState<TreeFilterMode>("default");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setView(await readSessionTree(sessionId, cwd ?? undefined));
    setLoading(false);
  }, [cwd, sessionId]);

  // The capability IS asked on mount — it decides whether the control exists
  // at all, and `server.info` is one cached round trip per folder.
  useEffect(() => {
    let cancelled = false;
    void supportsSessionTree(cwd ?? undefined).then((can) => {
      if (!cancelled) setSupported(can);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // The tree itself is read on open, not on mount: it walks every branch of
  // the session, and most threads are never asked about it.
  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  const goTo = useCallback(
    async (entryId: string | null) => {
      if (!sessionId) return;
      setBusy(true);
      setError(null);
      try {
        await branchSession(sessionId, entryId, cwd ?? undefined);
        setOpen(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        await load();
      } finally {
        setBusy(false);
      }
    },
    [cwd, load, sessionId],
  );

  const fork = useCallback(
    async (row: SessionTreeRow, position: "at" | "before") => {
      if (!sessionId) return;
      setBusy(true);
      setError(null);
      try {
        const forked = await forkSession(sessionId, row.id, position, cwd ?? undefined);
        setOpen(false);
        // Awaited: opening the fork waits for the shell to carry it, and a
        // failure there should surface here rather than vanish.
        await onOpenSession(forked.sessionId, forked.text);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [cwd, onOpenSession, sessionId],
  );

  const rows = useMemo(
    () =>
      view === null
        ? []
        : filterTreeRows({ rows: view.rows, mode, query, leafId: view.leafId }),
    [mode, query, view],
  );

  if (!sessionId || supported === false) return null;

  const branchCount = view?.branchPointIds.length ?? 0;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <button
            aria-label="Session branches"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          />
        }
      >
        <GitBranchIcon aria-hidden className="size-4 shrink-0" />
        {branchCount > 0 ? <span className="tabular-nums">{branchCount}</span> : null}
      </DialogTrigger>
      {/* Built from the app's own dialog anatomy — DialogHeader / DialogPanel
          / DialogFooter — rather than hand-rolled margins. Those three carry
          the padding, the scroll area and the footer rule that every other
          dialog here has; spacing it by hand is what made this one look
          different from the rest of the app. */}
      <DialogPopup className="max-h-[82vh] w-full max-w-3xl">
        <DialogHeader>
          <DialogTitle>Branches</DialogTitle>
          <DialogDescription>
            Go here moves this conversation back to that point — everything
            after it stays, it just stops being what the model sees. Fork
            copies the branch into a new session and leaves this one alone.
          </DialogDescription>

          <div className="flex flex-wrap items-center gap-2 pt-1">
          <div className="relative min-w-48 flex-1">
            <SearchIcon
              aria-hidden
              className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground/60"
            />
            <Input
              aria-label="Search this session"
              className="h-8 ps-8 text-sm"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search prompts, replies, commands…"
              value={query}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {TREE_FILTER_MODES.map((filter) => (
              <button
                className={cn(
                  "cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                  mode === filter.id
                    ? "border-border bg-accent text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                )}
                key={filter.id}
                onClick={() => setMode(filter.id)}
                title={filter.hint}
                type="button"
              >
                {filter.label}
              </button>
            ))}
            </div>
          </div>
        </DialogHeader>

        <DialogPanel className="min-h-0">
          {loading ? (
            <p className="py-6 text-center text-muted-foreground text-sm">Reading the tree…</p>
          ) : view === null ? (
            <p className="py-6 text-center text-muted-foreground text-sm">
              This loop does not report a session tree.
            </p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground text-sm">
              {query.trim() === "" ? "Nothing here yet — send a message first." : "No matches."}
            </p>
          ) : (
            <ul className="py-1">
              {rows.map((row) => {
                const isLeaf = row.id === view.leafId;
                return (
                  <li
                    className={cn(
                      "group flex items-center gap-2 rounded-md py-1 pe-1 ps-2",
                      isLeaf ? "bg-accent/50" : "hover:bg-accent/25",
                    )}
                    key={row.id}
                    style={{ marginInlineStart: `${row.indent * INDENT_STEP}px` }}
                  >
                    {/* The rail says "this is one of several ways the session
                        could have gone" — drawn only where that is true. */}
                    <span
                      aria-hidden
                      className={cn(
                        "w-2 shrink-0 self-stretch border-border/70 border-l",
                        row.branchStart ? "" : "border-transparent",
                      )}
                    />
                    <span
                      className={cn(
                        "shrink-0",
                        // On-path rows are the conversation; the rest are
                        // roads not taken and read as quieter.
                        row.onPath ? "text-muted-foreground/80" : "text-muted-foreground/35",
                      )}
                    >
                      <RowIcon row={row} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-[13px]",
                          row.onPath ? "text-foreground/90" : "text-muted-foreground/60",
                        )}
                      >
                        {row.label ? (
                          <span className="me-1.5 rounded bg-warning/15 px-1 py-px text-[10px] text-warning">
                            {row.label}
                          </span>
                        ) : null}
                        {treeRowSummary(row, cwd ?? "")}
                      </span>
                      <span className="block text-[11px] text-muted-foreground/50">
                        {row.role ?? row.type}
                        {" · "}
                        {TIME.format(new Date(row.ts))}
                        {row.childCount > 1 ? ` · forks ${row.childCount} ways` : ""}
                        {row.interrupted ? " · interrupted" : ""}
                      </span>
                    </span>

                    {isLeaf ? (
                      <span className="flex shrink-0 items-center gap-1 pe-1 text-[11px] text-muted-foreground/70">
                        <CheckIcon aria-hidden className="size-3" />
                        here
                      </span>
                    ) : null}
                    <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      {isLeaf ? null : (
                        <Button
                          disabled={busy || running}
                          onClick={() => void goTo(row.id)}
                          size="sm"
                          title="Move this conversation back to here"
                          type="button"
                          variant="ghost"
                        >
                          <CornerUpLeftIcon aria-hidden className="size-3.5" />
                          Go here
                        </Button>
                      )}
                      <Button
                        disabled={busy}
                        onClick={() => void fork(row, row.role === "user" ? "before" : "at")}
                        size="sm"
                        title="Copy this branch into a new session"
                        type="button"
                        variant="ghost"
                      >
                        <GitBranchIcon aria-hidden className="size-3.5" />
                        Fork
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {error ? <p className="pt-2 text-destructive text-xs">{error}</p> : null}
        </DialogPanel>

        <DialogFooter className="sm:justify-between">
          <p className="self-center text-muted-foreground/70 text-xs">
            {running
              ? "A turn is running — finish or stop it before moving the branch."
              : view
                ? `${treeSummary(view.rows, branchCount)}${
                    rows.length === view.rows.length ? "" : ` · showing ${rows.length}`
                  }`
                : ""}
          </p>
          <DialogClose render={<Button size="sm" type="button" variant="outline" />}>
            Close
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
