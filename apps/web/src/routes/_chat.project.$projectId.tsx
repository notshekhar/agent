/**
 * A project's sessions, in the main body.
 *
 * This is the half of the navigation change the sidebar cannot do: the sidebar
 * says which folder, and this says which session in it. Upstream had no such
 * screen — every thread lived in the sidebar tree — so it is new rather than
 * adapted.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CircleDashedIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { decodeProjectRouteId } from "../components/loop/projectRoute";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { useProjects, useThreadShells } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

function ProjectRouteView() {
  const { projectId: encodedProjectId } = Route.useParams();
  const navigate = useNavigate();
  const projectId = useMemo(() => decodeProjectRouteId(encodedProjectId), [encodedProjectId]);
  const projects = useProjects();
  const threads = useThreadShells();

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projectId, projects],
  );

  const sessions = useMemo(
    () =>
      threads
        .filter((thread) => thread.projectId === projectId)
        .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [projectId, threads],
  );

  const openNewThread = useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);

  if (projectId === null || project === null) {
    return (
      <SidebarInset className="min-w-0">
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyTitle>That project is not here</EmptyTitle>
            <EmptyDescription>
              A project exists while it has sessions. This one has none, or the folder was never
              opened in loop.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="min-w-0 overflow-y-auto">
      <header
        className={cn(
          "sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/80 px-6 py-4 backdrop-blur",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{project.title}</h1>
          <p className="truncate text-xs text-muted-foreground">{project.workspaceRoot}</p>
        </div>
        <Button onClick={openNewThread} size="sm" variant="outline">
          <PlusIcon />
          New session
        </Button>
      </header>

      {sessions.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>No sessions yet</EmptyTitle>
            <EmptyDescription>Start one to see it here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {sessions.map((session) => {
            const running = session.session?.status === "running";
            return (
              <li key={session.id}>
                <Link
                  className="flex items-center gap-3 px-6 py-3 transition-colors hover:bg-accent/50"
                  params={{ environmentId: session.environmentId, threadId: session.id }}
                  to="/$environmentId/$threadId"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{session.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {session.modelSelection.model}
                    </span>
                  </span>
                  {running ? (
                    <CircleDashedIcon className="size-4 shrink-0 animate-spin text-primary" />
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTimeLabel(session.updatedAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/project/$projectId")({
  component: ProjectRouteView,
});
