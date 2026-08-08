/**
 * What a project row in the sidebar says, and which row is the current one.
 *
 * Kept out of the component so the counting and the active-row rules can be
 * tested without a router or an atom registry. The inputs are structural
 * rather than the contract types: this file only needs the handful of fields
 * it reads, and staying structural keeps the test fixtures short.
 *
 * A project's own two ids are the exception and stay branded: a row hands them
 * straight back to `scopeProjectRef` to start a session, so widening them to
 * `string` would only move the cast into the component.
 */
import type { EnvironmentId, ProjectId } from "@loop/contracts";

export interface ProjectSidebarProjectInput {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly updatedAt: string;
}

export interface ProjectSidebarThreadInput {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title?: string;
  readonly updatedAt: string;
  readonly session: { readonly status: string } | null;
}

export interface ProjectSidebarRow {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly sessionCount: number;
  readonly runningCount: number;
  /** Epoch ms of the most recent session, or 0 when there is nothing to date. */
  readonly lastActivity: number;
}

/**
 * A project is only as interesting as its newest session, so ordering is by
 * last activity rather than by name — the folder you were just in stays at the
 * top without anyone maintaining a manual order.
 */
export function buildProjectSidebarRows(input: {
  readonly projects: readonly ProjectSidebarProjectInput[];
  readonly threads: readonly ProjectSidebarThreadInput[];
}): readonly ProjectSidebarRow[] {
  const counts = new Map<string, { total: number; running: number; last: number }>();
  for (const thread of input.threads) {
    const bucket = counts.get(thread.projectId) ?? { total: 0, running: 0, last: 0 };
    bucket.total += 1;
    if (thread.session?.status === "running") bucket.running += 1;
    const updated = Date.parse(thread.updatedAt);
    if (Number.isFinite(updated) && updated > bucket.last) bucket.last = updated;
    counts.set(thread.projectId, bucket);
  }

  return input.projects
    .map((project) => {
      const bucket = counts.get(project.id);
      const fallback = Date.parse(project.updatedAt);
      return {
        id: project.id,
        environmentId: project.environmentId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        sessionCount: bucket?.total ?? 0,
        runningCount: bucket?.running ?? 0,
        lastActivity: bucket?.last || (Number.isFinite(fallback) ? fallback : 0),
      } satisfies ProjectSidebarRow;
    })
    .toSorted((a, b) => b.lastActivity - a.lastActivity);
}

export function formatSessionCountLabel(count: number): string {
  if (count === 0) return "No sessions";
  return count === 1 ? "1 session" : `${count} sessions`;
}

/**
 * How many of a project's sessions sit in the open list before the rest go
 * behind the settled shelf, and how many that shelf reveals per press.
 *
 * The same two-tier shape t3code's nightly sidebar uses
 * (`SETTLED_TAIL_INITIAL_COUNT` / `SETTLED_TAIL_PAGE_COUNT`): the recent
 * handful is the common lookup, the deep tail stays behind one explicit step.
 */
export const SIDEBAR_SESSIONS_PER_PROJECT = 20;
export const SIDEBAR_SETTLED_PAGE = 25;

export interface ProjectSidebarSession {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly running: boolean;
}

/**
 * `15m`, not `15m ago` — a sidebar row has no width to spare.
 * `compactSidebarTimeLabel` in nightly's SidebarV2.
 */
export function compactTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

export interface ProjectSessionShelves {
  /** The recent ones, listed outright. */
  readonly active: readonly ProjectSidebarSession[];
  /** Everything older, behind the shelf. */
  readonly settled: readonly ProjectSidebarSession[];
  readonly settledCount: number;
}

/**
 * A project's sessions, split the way the nightly sidebar splits threads.
 *
 * loop has no settle flag — no `settledAt`, no snooze, no pins — so "settled"
 * cannot mean what it means upstream. It means the tail here: the sessions
 * past the recent ones, which is the same job the shelf does (keep the deep
 * history reachable without letting one busy folder bury every other project).
 *
 * `settledVisible` pages that tail, so the shelf grows a page at a time
 * instead of dumping three hundred rows into the list.
 */
export function sessionsForProject(input: {
  readonly threads: readonly ProjectSidebarThreadInput[];
  readonly projectId: string;
  readonly limit?: number;
  readonly settledVisible?: number;
}): ProjectSessionShelves {
  const limit = input.limit ?? SIDEBAR_SESSIONS_PER_PROJECT;
  const settledVisible = input.settledVisible ?? 0;
  const mine = input.threads
    .filter((thread) => thread.projectId === input.projectId)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map((thread) => ({
      id: thread.id,
      environmentId: thread.environmentId,
      title: thread.title?.trim() ? thread.title : "Untitled",
      updatedAt: thread.updatedAt,
      running: thread.session?.status === "running",
    }));
  const tail = mine.slice(limit);
  return {
    active: mine.slice(0, limit),
    settled: tail.slice(0, settledVisible),
    settledCount: tail.length,
  };
}

/**
 * Which project the sidebar should mark as current.
 *
 * The project route names its project outright, but most of the time the user
 * is inside a session or a draft instead — and a sidebar that highlights
 * nothing while a session from that folder is open reads as "you are nowhere".
 * So a thread or draft resolves back to the folder it belongs to.
 */
export function resolveActiveProjectId(input: {
  /** Already decoded — the route carries it base64url-encoded. */
  readonly routeProjectId?: string | null;
  readonly routeEnvironmentId?: string | null;
  readonly routeThreadId?: string | null;
  readonly routeDraftProjectId?: string | null;
  readonly threads: readonly ProjectSidebarThreadInput[];
}): string | null {
  if (input.routeProjectId) return input.routeProjectId;
  if (input.routeDraftProjectId) return input.routeDraftProjectId;
  if (!input.routeThreadId) return null;

  const thread = input.threads.find(
    (candidate) =>
      candidate.id === input.routeThreadId &&
      // A thread id is only unique within its environment, so an environment
      // in the route narrows the match. Routes that omit it match on id alone.
      (!input.routeEnvironmentId || candidate.environmentId === input.routeEnvironmentId),
  );
  return thread?.projectId ?? null;
}
