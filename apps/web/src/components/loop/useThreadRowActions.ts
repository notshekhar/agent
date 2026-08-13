/**
 * What a thread row can do: the right-click menu, and archiving.
 *
 * loop's own sidebars drew rows you could only OPEN. Upstream's has carried a
 * full context menu the whole time, and it is a native one — `api.contextMenu`
 * hands the items to Electron (with a DOM fallback in the browser), which is
 * why a right-click there feels like the OS and a `<div onContextMenu>` never
 * does.
 *
 * The items are upstream's, minus the ones that need machinery loop's sidebars
 * do not have (multi-select, snooze presets, title regeneration). Same
 * handlers underneath — `useThreadActions` — so settling from this menu and
 * settling from upstream's are the same call, and Delete keeps its confirm
 * while Archive deliberately does not: nothing is destroyed, and
 * Settings → Archive puts it straight back.
 */
import { scopeThreadRef } from "@loop/runtime/environment";
import { isAtomCommandInterrupted, settlePromise, squashAtomCommandFailure } from "@loop/runtime/state/runtime";
import { useCallback, useMemo } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { useProjects } from "../../state/entities";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { SidebarThreadRow } from "./sidebarThreads.logic";

export interface ThreadRowActions {
  readonly openContextMenu: (row: SidebarThreadRow, position: { x: number; y: number }) => void;
  readonly archive: (row: SidebarThreadRow) => void;
}

export function useThreadRowActions(): ThreadRowActions {
  const projects = useProjects();
  const { archiveThread, confirmAndDeleteThread, settleThread, unsettleThread } =
    useThreadActions();

  // A thread's path is its worktree when it has one, and its project's
  // workspace root otherwise — the same fallback upstream's menu makes.
  const cwdByProjectKey = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const project of projects) {
      byKey.set(`${project.environmentId}:${project.id}`, project.workspaceRoot);
    }
    return byKey;
  }, [projects]);

  const report = (title: string, result: { _tag: string }): void => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result as never)) return;
    const error = squashAtomCommandFailure(result as never);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  const archive = useCallback(
    (row: SidebarThreadRow) => {
      void (async () => {
        const result = await archiveThread(scopeThreadRef(row.environmentId, row.id));
        report("Failed to archive thread", result);
      })();
    },
    [archiveThread],
  );

  const copy = useCallback((value: string, label: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => toastManager.add({ type: "success", title: `${label} copied` }))
      .catch(() => toastManager.add({ type: "error", title: `Could not copy the ${label.toLowerCase()}` }));
  }, []);

  const openContextMenu = useCallback(
    (row: SidebarThreadRow, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadRef = scopeThreadRef(row.environmentId, row.id);
        const path = row.worktreePath ?? cwdByProjectKey.get(`${row.environmentId}:${row.projectId}`);
        const settled = row.state === "settled";

        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              settled
                ? { id: "unsettle" as const, label: "Un-settle thread" }
                : { id: "settle" as const, label: "Settle thread" },
              // The gentler neighbour of Delete, and deliberately next to it:
              // most of what you want out of the sidebar you do not want gone.
              { id: "archive" as const, label: "Archive", icon: "archive" },
              ...(path ? [{ id: "copy-path" as const, label: "Copy path", icon: "copy" }] : []),
              ...(row.branch
                ? [{ id: "copy-branch" as const, label: "Copy branch", icon: "copy" }]
                : []),
              { id: "delete" as const, label: "Delete", destructive: true, icon: "trash" },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;

        switch (clicked.value) {
          case "settle":
            report("Failed to settle thread", await settleThread(threadRef));
            return;
          case "unsettle":
            report("Failed to un-settle thread", await unsettleThread(threadRef));
            return;
          case "archive":
            archive(row);
            return;
          case "copy-path":
            if (path) copy(path, "Path");
            return;
          case "copy-branch":
            if (row.branch) copy(row.branch, "Branch");
            return;
          case "delete":
            // Keeps its confirmation (honouring the confirmThreadDelete
            // setting) — this is the one item here that destroys something.
            report("Failed to delete thread", await confirmAndDeleteThread(threadRef));
            return;
          default:
            return;
        }
      })();
    },
    [archive, confirmAndDeleteThread, copy, cwdByProjectKey, settleThread, unsettleThread],
  );

  return { openContextMenu, archive };
}
