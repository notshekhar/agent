import { RefreshCwIcon } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { useDesktopUpdateCheck } from "../useDesktopUpdateCheck";

/**
 * "Check for updates" in the sidebar footer.
 *
 * The update pill above it only appears once there is something to install,
 * which is the right behaviour for news but leaves no way to *ask*. Waiting up
 * to six hours for the timer, or quitting and reopening, was the only way to
 * find out — so this is the row that answers the question on demand, from
 * inside whatever session you are in.
 *
 * It renders nothing in the browser build or in a dev run out of the repo:
 * neither can replace the install, and a control that cannot work is worse
 * than an absent one.
 */
export function SidebarCheckUpdatesItem() {
  const { available, busy, run } = useDesktopUpdateCheck();
  if (!available) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-label="Check for updates"
        disabled={busy}
        onClick={busy ? undefined : run}
      >
        {/* Spins only while a check is in flight — the press has no other
            visible effect until the toast lands. */}
        <RefreshCwIcon className={busy ? "animate-spin" : undefined} />
        <span>{busy ? "Checking…" : "Check for updates"}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
