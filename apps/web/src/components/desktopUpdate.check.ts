import type { DesktopUpdateCheckResult, DesktopUpdateState } from "@loop/contracts";

/**
 * What a manual "check for updates" says when it is over.
 *
 * Three surfaces offer this — the Settings row, the sidebar footer and the
 * command palette — and they must agree, because they are the same action. So
 * the wording lives here rather than three times over, and this module stays
 * pure: it decides what to say, the callers decide how to show it.
 *
 * The automatic check on a six-hour timer says nothing at all. This exists for
 * the case where somebody pressed a button and is waiting to be told, where
 * silence is indistinguishable from a broken control — which is exactly what
 * the Settings button had been doing.
 */

export type DesktopUpdateCheckOutcomeKind = "up-to-date" | "available" | "downloaded" | "error";

export interface DesktopUpdateCheckOutcome {
  readonly kind: DesktopUpdateCheckOutcomeKind;
  readonly title: string;
  readonly description: string | null;
}

/** Whether the manual control should be offered at all. */
export function canRunDesktopUpdateCheck(state: DesktopUpdateState | null): boolean {
  // A build that cannot install anything (a dev run out of the repo) offers no
  // check: the honest answer is that this surface does not apply here.
  return state !== null && state.enabled && state.status !== "disabled";
}

/** Whether the control should be inert right now — busy, not unavailable. */
export function isDesktopUpdateCheckBusy(state: DesktopUpdateState | null): boolean {
  return (
    state?.status === "checking" || state?.status === "downloading" || state?.status === "downloaded"
  );
}

const versioned = (label: string, version: string | null): string =>
  version ? `${label} ${version}` : label;

/**
 * Turn a finished check into something to tell the user.
 *
 * `checked: false` is its own case and not an error: the request never went
 * out, because this build has updates switched off or another check was
 * already running. Reporting that as "up to date" would be a lie, and
 * reporting it as a failure would be alarming.
 */
export function describeDesktopUpdateCheck(
  result: DesktopUpdateCheckResult,
): DesktopUpdateCheckOutcome | null {
  const { state } = result;

  if (!result.checked) {
    if (!state.enabled || state.status === "disabled") {
      return {
        kind: "error",
        title: "Updates are not available in this build",
        description:
          "This copy of loop was not installed by the updater, so it cannot replace itself.",
      };
    }
    // A check was already running — the one in flight will report for both.
    return null;
  }

  if (state.status === "error") {
    return {
      kind: "error",
      title: "Could not check for updates",
      description: state.message ?? "The update check failed.",
    };
  }

  // An update downloaded earlier is still the news, even though this check
  // found nothing newer: the user is one restart from having it.
  if (state.downloadedVersion) {
    return {
      kind: "downloaded",
      title: versioned("Update ready:", state.downloadedVersion),
      description: "Restart loop to install it.",
    };
  }

  if (state.status === "available") {
    return {
      kind: "available",
      title: versioned("Update available:", state.availableVersion),
      description: "Download it from the update button in the sidebar.",
    };
  }

  return {
    kind: "up-to-date",
    title: versioned("loop is up to date", state.currentVersion),
    description: null,
  };
}
