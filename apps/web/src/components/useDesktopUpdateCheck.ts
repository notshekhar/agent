import { useCallback } from "react";
import { desktopUpdateBridge } from "./desktopUpdateBridge";
import { canRunDesktopUpdateCheck, describeDesktopUpdateCheck, isDesktopUpdateCheckBusy } from "./desktopUpdate.check";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** Toast type per outcome — an available update is news, not a warning. */
const TOAST_TYPE = {
  "up-to-date": "success",
  available: "info",
  downloaded: "info",
  error: "error",
} as const;

export interface DesktopUpdateCheckControl {
  /** Offer the control at all: false in the browser build and in a dev run. */
  readonly available: boolean;
  /** Offered, but inert right now — a check or download is already running. */
  readonly busy: boolean;
  readonly run: () => void;
}

/**
 * The manual update check, shared by every surface that offers it.
 *
 * All three callers (Settings, the sidebar footer, the command palette) get
 * the same behaviour and the same words from here, so the action cannot mean
 * one thing in one place and something else in another. The wording itself is
 * in `desktopUpdate.check.ts`, which is pure and tested.
 */
export function useDesktopUpdateCheck(): DesktopUpdateCheckControl {
  const state = useDesktopUpdateState();
  const bridge = desktopUpdateBridge;
  // `checkForUpdate` is optional on the contract, and the browser build has no
  // bridge at all — both mean there is nothing to offer.
  const available =
    bridge !== undefined && typeof bridge.checkForUpdate === "function" && canRunDesktopUpdateCheck(state);
  const busy = isDesktopUpdateCheckBusy(state);

  const run = useCallback(() => {
    if (!bridge || typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        const outcome = describeDesktopUpdateCheck(result);
        // null = a check was already in flight; that one will report.
        if (!outcome) return;
        toastManager.add(
          stackedThreadToast({
            type: TOAST_TYPE[outcome.kind],
            title: outcome.title,
            ...(outcome.description === null ? {} : { description: outcome.description }),
          }),
        );
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "The update check failed.",
          }),
        );
      });
  }, [bridge]);

  return { available, busy, run };
}
