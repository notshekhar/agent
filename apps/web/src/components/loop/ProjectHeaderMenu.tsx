/**
 * The project actions, for the sidebar that has no project rows.
 *
 * Focused mode puts one project in a switcher, so there is nothing to hover —
 * the same menu the `projects` rows carry rides the header instead. Same
 * actions, same handlers (`useProjectActions`); only the trigger differs, which
 * is why this is a thin component rather than a second implementation.
 *
 * "New thread" is absent on purpose: it is already the first row of the nav
 * directly underneath, and repeating it in a menu two pixels away is noise.
 */
import { ClipboardIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import type { ProjectActionTarget } from "./useProjectActions";

export const ProjectHeaderMenu = memo(function ProjectHeaderMenu({
  project,
  onStartRename,
  onCopyPath,
  onRemove,
}: {
  project: ProjectActionTarget;
  onStartRename: (project: ProjectActionTarget) => void;
  onCopyPath: (project: ProjectActionTarget) => void;
  onRemove: (project: ProjectActionTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu onOpenChange={setOpen} open={open}>
      <MenuTrigger
        render={
          <button
            aria-label={`Actions for ${project.title}`}
            className={cn(
              "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground",
              "outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2",
              open && "bg-sidebar-row-hover text-sidebar-foreground",
            )}
            type="button"
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end">
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
