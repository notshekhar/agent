/**
 * The controls a project row carries: new thread, rename, copy path, remove.
 *
 * Both of loop's own sidebars shipped a project list with exactly one action on
 * it — the hover "+" — while upstream's row has had the full set the whole
 * time. Adding a project was reachable, removing one was not, which makes the
 * list a place you can only ever add to.
 *
 * Rename happens IN THE ROW rather than in a dialog: the row is where the title
 * is, and a dialog to change one word is a lot of ceremony. Escape reverts,
 * Enter and blur commit — the same three keys the thread rename uses in
 * upstream's sidebar. Removal keeps its confirm (see `useProjectActions`),
 * because it deletes conversations.
 */
import { MoreHorizontalIcon, PencilIcon, PlusIcon, ClipboardIcon, Trash2Icon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarMenuAction } from "../ui/sidebar";
import type { ProjectActionTarget } from "./useProjectActions";

export const ProjectRowMenu = memo(function ProjectRowMenu({
  project,
  onNewThread,
  onStartRename,
  onCopyPath,
  onRemove,
}: {
  project: ProjectActionTarget;
  onNewThread: (project: ProjectActionTarget) => void;
  onStartRename: (project: ProjectActionTarget) => void;
  onCopyPath: (project: ProjectActionTarget) => void;
  onRemove: (project: ProjectActionTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu onOpenChange={setOpen} open={open}>
      <MenuTrigger
        render={
          // Held visible while the menu is open: a hover-only trigger that
          // vanishes the moment the pointer moves to its own menu is a trap.
          <SidebarMenuAction
            aria-label={`Actions for ${project.title}`}
            className={cn("-translate-y-1/2 top-1/2!", open && "opacity-100")}
            showOnHover
            title={`Actions for ${project.title}`}
          />
        }
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="start" side="right">
        <MenuItem onClick={() => onNewThread(project)}>
          <PlusIcon />
          New thread
        </MenuItem>
        <MenuItem onClick={() => onStartRename(project)}>
          <PencilIcon />
          Rename
        </MenuItem>
        <MenuItem onClick={() => onCopyPath(project)}>
          <ClipboardIcon />
          Copy path
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          className="text-destructive-foreground data-[highlighted]:bg-destructive/8 data-[highlighted]:text-destructive-foreground"
          onClick={() => onRemove(project)}
        >
          <Trash2Icon />
          Remove project
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});

/**
 * The row's title, swapped for an input while it is being renamed.
 *
 * Selected on mount, so the common case — replacing the whole name — is one
 * keystroke rather than a select-all first.
 */
export const ProjectTitleEditor = memo(function ProjectTitleEditor({
  title,
  onCommit,
  onCancel,
}: {
  title: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks whether the edit already ended, so the blur that follows Enter or
  // Escape does not commit a second time.
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(draft);
  }, [draft, onCommit]);

  const cancel = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  }, [onCancel]);

  return (
    <input
      aria-label={`Rename ${title}`}
      className="min-w-0 flex-1 rounded-sm bg-transparent text-sidebar-foreground outline-hidden ring-1 ring-ring/60 focus-visible:ring-2"
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => {
        // The row underneath is a link; a click in the input must not navigate.
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      ref={inputRef}
      value={draft}
    />
  );
});
