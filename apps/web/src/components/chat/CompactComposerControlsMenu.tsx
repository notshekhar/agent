/**
 * The narrow-composer overflow menu.
 *
 * The Mode (Chat/Plan) and Access (Supervised…Full access) radio groups were
 * removed to match the wide footer: neither ever reached loop — a turn carries
 * a model, a thinking level and an agent — so both were decoration. loop's
 * equivalents live where the terminal keeps them: access is the `bashApprove`
 * setting, and planning is an agent chosen in the composer's agent picker.
 *
 * That agent picker lives here too. It is a standalone control in the wide
 * footer, but the narrow footer drops everything except the model — so in the
 * desktop window, where a sidebar and a right panel routinely take the width,
 * there was no way to change agent at all.
 */
import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListTodoIcon } from "lucide-react";
import { Button } from "../ui/button";
import { MenuItem, MenuPopup, MenuSeparator as MenuDivider, MenuTrigger, Menu } from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  traitsMenuContent?: ReactNode;
  /** The agent section, when loop offers more than the built-in persona. */
  agentMenuContent?: ReactNode;
  onTogglePlanSidebar: () => void;
}) {
  // With the two radio groups gone the menu can be empty — an ellipsis button
  // that opens nothing is worse than no button.
  if (!props.traitsMenuContent && !props.agentMenuContent && !props.activePlan) {
    return null;
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent}
        {props.traitsMenuContent && props.agentMenuContent ? <MenuDivider /> : null}
        {props.agentMenuContent}
        {(props.traitsMenuContent || props.agentMenuContent) && props.activePlan ? (
          <MenuDivider />
        ) : null}
        {props.activePlan ? (
          <MenuItem onClick={props.onTogglePlanSidebar}>
            <ListTodoIcon className="size-4 shrink-0" />
            {props.planSidebarOpen
              ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
              : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
