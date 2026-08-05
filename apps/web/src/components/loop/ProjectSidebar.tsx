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
 * Projects come from the same atoms the old sidebars used, so this is a
 * presentation change only: no new data path, and the shell handler stays the
 * one place that decides what a project is.
 */
import { FolderIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { Link, useParams } from "@tanstack/react-router";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useProjects, useThreadShells } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { encodeProjectRouteId } from "./projectRoute";

interface ProjectRow {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly threadCount: number;
  /** Epoch ms of the most recent session in this project. */
  readonly lastActivity: number;
  readonly runningCount: number;
}

/**
 * A project is only as interesting as its newest session, so ordering is by
 * last activity rather than by name — the folder you were just in stays at the
 * top without anyone maintaining a manual order.
 */
function useProjectRows(): readonly ProjectRow[] {
  const projects = useProjects();
  const threads = useThreadShells();

  return useMemo(() => {
    const counts = new Map<string, { total: number; running: number; last: number }>();
    for (const thread of threads) {
      const bucket = counts.get(thread.projectId) ?? { total: 0, running: 0, last: 0 };
      bucket.total += 1;
      if (thread.session?.status === "running") bucket.running += 1;
      const updated = Date.parse(thread.updatedAt);
      if (Number.isFinite(updated) && updated > bucket.last) bucket.last = updated;
      counts.set(thread.projectId, bucket);
    }

    return projects
      .map((project) => {
        const bucket = counts.get(project.id);
        const fallback = Date.parse(project.updatedAt);
        return {
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          threadCount: bucket?.total ?? 0,
          runningCount: bucket?.running ?? 0,
          lastActivity: bucket?.last || (Number.isFinite(fallback) ? fallback : 0),
        } satisfies ProjectRow;
      })
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }, [projects, threads]);
}

const ProjectRowItem = memo(function ProjectRowItem({
  project,
  active,
}: {
  project: ProjectRow;
  active: boolean;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        render={
          <Link params={{ projectId: encodeProjectRouteId(project.id) }} to="/project/$projectId" />
        }
        tooltip={project.workspaceRoot}
      >
        <FolderIcon />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate">{project.title}</span>
          {project.lastActivity > 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatRelativeTimeLabel(new Date(project.lastActivity).toISOString())}
            </span>
          ) : null}
        </span>
      </SidebarMenuButton>
      <SidebarMenuBadge
        className={cn(project.runningCount > 0 && "text-primary")}
        title={
          project.runningCount > 0
            ? `${project.runningCount} running of ${project.threadCount}`
            : `${project.threadCount} sessions`
        }
      >
        {project.runningCount > 0 ? `${project.runningCount}/${project.threadCount}` : project.threadCount}
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
});

export default function ProjectSidebar() {
  const rows = useProjectRows();
  const params = useParams({ strict: false }) as { projectId?: string };
  const activeId = params.projectId;

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
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
                  <span className="px-2 py-1.5 text-sm text-muted-foreground">No projects yet</span>
                </SidebarMenuItem>
              ) : (
                rows.map((project) => (
                  <ProjectRowItem
                    active={activeId === encodeProjectRouteId(project.id)}
                    key={project.id}
                    project={project}
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
