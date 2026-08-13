/**
 * Renaming and removing a project, for the sidebars that are not upstream's.
 *
 * `SidebarV2` owns these actions inside a 3.2k-line component, wrapped in a
 * project-GROUP model (one logical project can span several environments) that
 * loop's own sidebars do not have — they list projects flat. So the behaviour
 * is reproduced here for the single-project case rather than lifted whole, and
 * deliberately reproduced EXACTLY: the same two commands, the same confirm
 * copy, the same failure toasts, and the same navigation rule when you delete
 * the project you are currently looking at.
 *
 * The rule that matters and is easy to miss: removing a project deletes its
 * threads, so if the open thread belonged to it the app has to leave the route
 * before the row disappears underneath it.
 */
import type { EnvironmentId, ProjectId } from "@loop/contracts";
import { scopeProjectRef } from "@loop/runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import { useCallback } from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "../../composerDraftStore";
import { readLocalApi } from "../../localApi";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadShells } from "../../state/entities";
import { shouldNavigateAfterProjectRemoval } from "../Sidebar.logic";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * The project a menu is acting on.
 *
 * Both ids stay branded: they are handed straight to the project commands, so
 * widening them to `string` would only move the cast to every caller.
 */
export interface ProjectActionTarget {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ProjectActions {
  /** Rename in place. An empty title is refused rather than written. */
  readonly renameProject: (project: ProjectActionTarget, nextTitle: string) => Promise<void>;
  /** Confirm, then delete the project and every thread in it. */
  readonly removeProject: (project: ProjectActionTarget) => Promise<void>;
  readonly copyProjectPath: (project: ProjectActionTarget) => void;
  /**
   * The same actions, on right-click.
   *
   * A row with a hover menu still has to answer a right-click — that is where
   * people look for row actions first, and a row that ignores it reads as
   * having none. Takes the caller's rename starter, because renaming happens
   * in the row and only the row knows how to enter that state.
   */
  readonly openProjectContextMenu: (
    project: ProjectActionTarget,
    position: { x: number; y: number },
    handlers: { onNewThread: () => void; onStartRename: () => void },
  ) => void;
}

export function useProjectActions(): ProjectActions {
  const router = useRouter();
  const threads = useThreadShells();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftStore = useComposerDraftStore;
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });

  const renameProject = useCallback(
    async (project: ProjectActionTarget, nextTitle: string) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Project title cannot be empty" });
        return;
      }
      if (title === project.title) return;
      const result = await updateProject({
        environmentId: project.environmentId,
        input: { projectId: project.id, title },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [updateProject],
  );

  const removeProject = useCallback(
    async (project: ProjectActionTarget) => {
      const api = readLocalApi();
      if (!api) return;

      const projectThreads = threads.filter(
        (thread) =>
          thread.environmentId === project.environmentId && thread.projectId === project.id,
      );
      const projectRef = scopeProjectRef(project.environmentId, project.id);
      const projectDraftThread = draftStore.getState().getDraftThreadByProjectRef?.(projectRef);

      // The count is in the question on purpose: "remove project" and "delete
      // eleven conversations" are different decisions, and only one of them is
      // what the menu item says.
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          (projectThreads.length > 0
            ? [
                `Remove project "${project.title}" and delete its ${projectThreads.length} thread${
                  projectThreads.length === 1 ? "" : "s"
                }?`,
                `Path: ${project.workspaceRoot}`,
                "This permanently clears conversation history for those threads.",
              ]
            : [`Remove project "${project.title}"?`, `Path: ${project.workspaceRoot}`]
          )
            .concat([
              "This removes only the project entry, not the files on disk.",
              "This action cannot be undone.",
            ])
            .join("\n"),
        ),
      );
      if (confirmed._tag !== "Success" || !confirmed.value) return;

      const needsNavigation = shouldNavigateAfterProjectRemoval({
        routeTarget,
        projectThreads,
        projectDraftId: projectDraftThread?.draftId ?? null,
      });

      const result = await deleteProject({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          ...(projectThreads.length > 0 ? { force: true } : {}),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to remove "${project.title}"`,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (projectDraftThread) draftStore.getState().clearDraftThread(projectDraftThread.draftId);
      draftStore.getState().clearProjectDraftThreadId(projectRef);
      // Last, and only on success: the route has to leave before the row it is
      // pointing at stops existing.
      if (needsNavigation) void router.navigate({ to: "/" });
    },
    [deleteProject, draftStore, routeTarget, router, threads],
  );

  const copyProjectPath = useCallback((project: ProjectActionTarget) => {
    void navigator.clipboard
      .writeText(project.workspaceRoot)
      .then(() => toastManager.add({ type: "success", title: "Path copied" }))
      .catch(() => toastManager.add({ type: "error", title: "Could not copy the path" }));
  }, []);

  const openProjectContextMenu = useCallback(
    (
      project: ProjectActionTarget,
      position: { x: number; y: number },
      handlers: { onNewThread: () => void; onStartRename: () => void },
    ) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              { id: "new-thread" as const, label: "New thread" },
              { id: "rename" as const, label: "Rename project", icon: "pencil" },
              { id: "copy-path" as const, label: "Copy path", icon: "copy" },
              { id: "remove" as const, label: "Remove project", destructive: true, icon: "trash" },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "new-thread":
            handlers.onNewThread();
            return;
          case "rename":
            handlers.onStartRename();
            return;
          case "copy-path":
            copyProjectPath(project);
            return;
          case "remove":
            void removeProject(project);
            return;
          default:
            return;
        }
      })();
    },
    [copyProjectPath, removeProject],
  );

  return { renameProject, removeProject, copyProjectPath, openProjectContextMenu };
}
