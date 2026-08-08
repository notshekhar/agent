/**
 * loop's sidebar: projects, and nothing else.
 *
 * Upstream shipped two sidebars (3.6k and 3.2k lines) that nest every thread
 * under its project, so the list is as long as your entire history. loop's
 * navigation is one level shallower on purpose — the sidebar answers "which
 * folder", and the project view answers "which session in it". Neither
 * inherited sidebar is a starting point for that, so this is written rather
 * than carved out of them.
 *
 * A row therefore has to carry what the nesting used to show at a glance: how
 * many sessions the folder holds, whether any is running, and how recently it
 * was touched. Starting a session is the one action a row offers, and it is
 * revealed on hover so the resting list stays a list of folders.
 *
 * Projects come from the same atoms the old sidebars used, so this is a
 * presentation change only: no new data path, and the shell handler stays the
 * one place that decides what a project is.
 */
import { scopeProjectRef } from "@loop/runtime/environment";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "@tanstack/react-router";

import { openCommandPalette } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
import { isDesktopShell } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects, useThreadShells } from "../../state/entities";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { SettingsSidebarNav } from "../settings/SettingsSidebarNav";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import {
  buildProjectSidebarRows,
  formatSessionCountLabel,
  compactTimeLabel,
  resolveActiveProjectId,
  sessionsForProject,
  SIDEBAR_SETTLED_PAGE,
  type ProjectSidebarRow,
  type ProjectSidebarSession,
  type ProjectSidebarThreadInput,
} from "./ProjectSidebar.logic";
import { decodeProjectRouteId, encodeProjectRouteId } from "./projectRoute";

/** One session, with nightly's row anatomy: status, title, compact time. */
const SessionRow = memo(function SessionRow({
  session,
  active,
}: {
  session: ProjectSidebarSession;
  active: boolean;
}) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        isActive={active}
        render={
          <Link
            params={{ environmentId: session.environmentId, threadId: session.id }}
            to="/$environmentId/$threadId"
          />
        }
      >
        {/* The status slot is always present, so a session starting or
            finishing does not shift the title under the cursor. */}
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            session.running ? "animate-pulse bg-primary" : "bg-transparent",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        <span className="shrink-0 text-[10px] text-sidebar-muted-foreground/55 tabular-nums">
          {compactTimeLabel(formatRelativeTimeLabel(session.updatedAt))}
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});

/**
 * A project's sessions, under the project.
 *
 * The sidebar answers "which folder" and the project page answers "which
 * session in it" — but switching between two or three sessions in the same
 * folder is something people do constantly, and routing that through a second
 * page every time is friction.
 *
 * The two-tier shape is nightly's: the recent ones listed outright, the deep
 * tail behind one labelled shelf that pages rather than dumping every row.
 */
const ProjectSessionList = memo(function ProjectSessionList({
  sessions,
  settled,
  settledCount,
  settledOpen,
  onToggleSettled,
  onShowMoreSettled,
  activeSessionId,
}: {
  sessions: readonly ProjectSidebarSession[];
  settled: readonly ProjectSidebarSession[];
  settledCount: number;
  settledOpen: boolean;
  onToggleSettled: () => void;
  onShowMoreSettled: () => void;
  activeSessionId: string | null;
}) {
  if (sessions.length === 0) return null;
  const remaining = settledCount - settled.length;
  return (
    <SidebarMenuSub className="mr-0 gap-px pr-0">
      {sessions.map((session) => (
        <SessionRow active={session.id === activeSessionId} key={session.id} session={session} />
      ))}

      {settledCount > 0 ? (
        <li className="list-none">
          {/* Label, hairline, chevron — the shelf header reads as a divider
              with a count rather than another row competing with the sessions. */}
          <button
            aria-expanded={settledOpen}
            className="mt-2 mb-1 flex w-full cursor-pointer items-center gap-2 px-2 text-left"
            onClick={onToggleSettled}
            type="button"
          >
            <span className="font-medium text-[11px] text-sidebar-muted-foreground/50">
              {settledOpen ? "Settled" : `Settled (${settledCount})`}
            </span>
            <span aria-hidden className="h-px flex-1 bg-sidebar-border/60" />
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3 text-sidebar-muted-foreground/50 transition-transform",
                settledOpen && "rotate-180",
              )}
            />
          </button>
        </li>
      ) : null}

      {settledOpen
        ? settled.map((session) => (
            <SessionRow
              active={session.id === activeSessionId}
              key={session.id}
              session={session}
            />
          ))
        : null}

      {settledOpen && remaining > 0 ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton
            className="text-sidebar-muted-foreground/55"
            onClick={onShowMoreSettled}
          >
            <PlusIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              Show {Math.min(remaining, SIDEBAR_SETTLED_PAGE)} more
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </SidebarMenuSub>
  );
});

const ProjectRowItem = memo(function ProjectRowItem({
  project,
  active,
  expanded,
  onToggle,
  onNewSession,
  sessions,
  settled,
  settledCount,
  settledOpen,
  onToggleSettled,
  onShowMoreSettled,
  activeSessionId,
}: {
  project: ProjectSidebarRow;
  active: boolean;
  expanded: boolean;
  onToggle: (project: ProjectSidebarRow) => void;
  onNewSession: (project: ProjectSidebarRow) => void;
  sessions: readonly ProjectSidebarSession[];
  settled: readonly ProjectSidebarSession[];
  settledCount: number;
  settledOpen: boolean;
  onToggleSettled: () => void;
  onShowMoreSettled: () => void;
  activeSessionId: string | null;
}) {
  const relativeTime =
    project.lastActivity > 0
      ? compactTimeLabel(formatRelativeTimeLabel(new Date(project.lastActivity).toISOString()))
      : null;

  return (
    <SidebarMenuItem>
      {/* pr-8 keeps the count clear of the hover action overlaying the right
          edge. */}
      <SidebarMenuButton
        className="pr-8"
        isActive={active}
        render={
          <Link params={{ projectId: encodeProjectRouteId(project.id) }} to="/project/$projectId" />
        }
        tooltip={project.workspaceRoot}
      >
        {/* The disclosure sits inside the row but swallows the click, so the
            row itself still navigates to the project page. */}
        <span
          aria-label={expanded ? `Collapse ${project.title}` : `Expand ${project.title}`}
          className="-m-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded p-1 hover:bg-sidebar-row-hover"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle(project);
          }}
          role="button"
          tabIndex={-1}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </span>
        <FolderIcon />
        <span className="min-w-0 flex-1 truncate">{project.title}</span>
        {/* Count and time ride the right edge as one compact figure, the way
            a nightly row does — a second line per project cost more height
            than this list can afford. */}
        <span
          className="flex shrink-0 items-center gap-1 font-normal text-[10px] text-sidebar-muted-foreground/55 tabular-nums"
          title={`${formatSessionCountLabel(project.sessionCount)}${
            project.runningCount > 0 ? `, ${project.runningCount} running` : ""
          }`}
        >
          {project.runningCount > 0 ? (
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />
          ) : null}
          {project.sessionCount > 0 ? <span>{project.sessionCount}</span> : null}
          {relativeTime === null ? null : (
            <>
              <span aria-hidden className="text-sidebar-muted-foreground/35">·</span>
              <span>{relativeTime}</span>
            </>
          )}
        </span>
      </SidebarMenuButton>
      {/* `!` is load-bearing: the component's own
          `peer-data-[size=default]/menu-button:top-1.5` is a variant selector
          and outranks a plain `top-1/2`. */}
      <SidebarMenuAction
        className="-translate-y-1/2 top-1/2!"
        onClick={() => onNewSession(project)}
        showOnHover
        title={`New session in ${project.title}`}
      >
        <PlusIcon />
        <span className="sr-only">New session in {project.title}</span>
      </SidebarMenuAction>
      {expanded ? (
        <ProjectSessionList
          activeSessionId={activeSessionId}
          onShowMoreSettled={onShowMoreSettled}
          onToggleSettled={onToggleSettled}
          sessions={sessions}
          settled={settled}
          settledCount={settledCount}
          settledOpen={settledOpen}
        />
      ) : null}
    </SidebarMenuItem>
  );
});

/**
 * The session list is derived per project, and only for the ones that are
 * open — slicing every project's threads on every render would walk the whole
 * history for rows nobody is looking at.
 */
const ExpandableProjectRow = memo(function ExpandableProjectRow({
  project,
  threads,
  expanded,
  ...rest
}: {
  project: ProjectSidebarRow;
  threads: readonly ProjectSidebarThreadInput[];
  active: boolean;
  expanded: boolean;
  activeSessionId: string | null;
  onToggle: (project: ProjectSidebarRow) => void;
  onNewSession: (project: ProjectSidebarRow) => void;
}) {
  // The shelf is per project and lives here rather than in the parent: only
  // one project's tail is ever being paged, and hoisting it would re-render
  // every row each time a page is revealed.
  const [settledOpen, setSettledOpen] = useState(false);
  const [settledVisible, setSettledVisible] = useState(SIDEBAR_SETTLED_PAGE);
  const onToggleSettled = useCallback(() => setSettledOpen((open) => !open), []);
  const onShowMoreSettled = useCallback(
    () => setSettledVisible((count) => count + SIDEBAR_SETTLED_PAGE),
    [],
  );

  const { active: sessions, settled, settledCount } = useMemo(
    () =>
      expanded
        ? sessionsForProject({
            threads,
            projectId: project.id,
            ...(settledOpen ? { settledVisible } : {}),
          })
        : EMPTY_SESSIONS,
    [expanded, project.id, settledOpen, settledVisible, threads],
  );
  return (
    <ProjectRowItem
      {...rest}
      expanded={expanded}
      onShowMoreSettled={onShowMoreSettled}
      onToggleSettled={onToggleSettled}
      project={project}
      sessions={sessions}
      settled={settled}
      settledCount={settledCount}
      settledOpen={settledOpen}
    />
  );
});

const EMPTY_SESSIONS = {
  active: [] as readonly ProjectSidebarSession[],
  settled: [] as readonly ProjectSidebarSession[],
  settledCount: 0,
} as const;

export default function ProjectSidebar() {
  const projects = useProjects();
  const threads = useThreadShells();
  const rows = useMemo(
    () => buildProjectSidebarRows({ projects, threads }),
    [projects, threads],
  );

  const params = useParams({ strict: false }) as {
    projectId?: string;
    environmentId?: string;
    threadId?: string;
    draftId?: string;
  };
  // A draft has no server thread to look up, so it carries its own project.
  const draftProjectId = useComposerDraftStore((store) =>
    params.draftId ? (store.draftThreadsByThreadKey[params.draftId]?.projectId ?? null) : null,
  );
  const activeProjectId = useMemo(
    () =>
      resolveActiveProjectId({
        routeProjectId: params.projectId ? decodeProjectRouteId(params.projectId) : null,
        routeEnvironmentId: params.environmentId ?? null,
        routeThreadId: params.threadId ?? null,
        routeDraftProjectId: draftProjectId,
        threads,
      }),
    [draftProjectId, params.environmentId, params.projectId, params.threadId, threads],
  );

  // Starts the draft already pointed at that folder, the same way the project
  // view's own button does — the row is the one place that knows which folder
  // the user meant, and losing it means picking it again in the composer.
  const startNewThread = useNewThreadHandler();
  const onNewSession = useCallback(
    (project: ProjectSidebarRow) => {
      void startNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [startNewThread],
  );

  // Which projects show their sessions. The one you are in opens itself —
  // that is the list you are switching within — and anything else is a
  // deliberate toggle that then sticks.
  const [toggledProjectIds, setToggledProjectIds] = useState<ReadonlySet<string>>(new Set());
  const onToggle = useCallback((project: ProjectSidebarRow) => {
    setToggledProjectIds((existing) => {
      const next = new Set(existing);
      if (next.has(project.id)) next.delete(project.id);
      else next.add(project.id);
      return next;
    });
  }, []);
  const isExpanded = useCallback(
    (projectId: string) =>
      projectId === activeProjectId
        ? !toggledProjectIds.has(projectId)
        : toggledProjectIds.has(projectId),
    [activeProjectId, toggledProjectIds],
  );

  const pathname = useLocation({ select: (location) => location.pathname });

  // Settings replaces the whole list with its own section nav — the same swap
  // upstream did inside its sidebar. Without it the settings page shows a
  // project list and no way to move between sections, which is exactly what
  // happened once the old sidebar (the only thing mounting this nav) stopped
  // rendering.
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  if (isOnSettings) {
    return (
      <>
        <SidebarChromeHeader isDesktopShell={isDesktopShell} />
        <SettingsSidebarNav pathname={pathname} />
      </>
    );
  }

  return (
    <>
      <SidebarChromeHeader isDesktopShell={isDesktopShell} />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => openCommandPalette()}>
                  <SearchIcon />
                  <span>Search</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => openCommandPalette({ open: "add-project" })}>
                  <SquarePenIcon />
                  <span>Add project</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {rows.length === 0 ? (
                <SidebarMenuItem>
                  <span className="px-2 py-1.5 text-muted-foreground text-sm">No projects yet</span>
                </SidebarMenuItem>
              ) : (
                rows.map((project) => (
                  <ExpandableProjectRow
                    active={activeProjectId === project.id}
                    activeSessionId={params.threadId ?? null}
                    expanded={isExpanded(project.id)}
                    key={project.id}
                    onNewSession={onNewSession}
                    onToggle={onToggle}
                    project={project}
                    threads={threads}
                  />
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
