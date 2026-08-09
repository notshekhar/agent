/**
 * The user-facing half of `/reload`: run it, then say what happened.
 *
 * Split from `loop/reload.ts` on the usual line — that file talks to loop and
 * throws, this one owns the toasts — so the RPC seam stays testable without a
 * toast manager and every caller (composer command, command palette) reports a
 * reload the same way.
 */
import { reloadLoopConfig } from "../loop/reload";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/**
 * Reload loop's config and report the outcome.
 *
 * Never throws: a failed reload is a toast, not an exception that takes the
 * composer's submit handler down with it. Returns whether it worked, for a
 * caller that wants to do something else afterwards.
 */
export async function runConfigReload(cwd?: string): Promise<boolean> {
  try {
    const summary = await reloadLoopConfig(cwd);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Reloaded",
        // The counts are the proof it did something — a bare "Reloaded" is
        // indistinguishable from a no-op, which is exactly the doubt that made
        // people restart the app in the first place.
        description: `${summary.availableModels} of ${summary.models} models available · ${summary.providers} providers · ${summary.agents} agents · ${summary.commands} commands`,
      }),
    );
    return true;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Reload failed",
        description:
          error instanceof Error
            ? error.message
            : "loop did not reload its configuration. It may be an older version.",
      }),
    );
    return false;
  }
}
