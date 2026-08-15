import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateCheckResult, DesktopUpdateState } from "@loop/contracts";

import { canRunDesktopUpdateCheck, describeDesktopUpdateCheck, isDesktopUpdateCheckBusy } from "./desktopUpdate.check";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

const result = (checked: boolean, state: Partial<DesktopUpdateState> = {}): DesktopUpdateCheckResult => ({
  checked,
  state: { ...baseState, ...state },
});

describe("offering the manual check", () => {
  it("is offered on an ordinary install", () => {
    expect(canRunDesktopUpdateCheck(baseState)).toBe(true);
  });

  it("is not offered where nothing could be installed", () => {
    // The browser build has no state at all; a dev run out of the repo reports
    // disabled. A control that cannot work is worse than an absent one.
    expect(canRunDesktopUpdateCheck(null)).toBe(false);
    expect(canRunDesktopUpdateCheck({ ...baseState, enabled: false })).toBe(false);
    expect(canRunDesktopUpdateCheck({ ...baseState, status: "disabled" })).toBe(false);
  });

  it("stays offered after a failed check, so it can be retried", () => {
    expect(canRunDesktopUpdateCheck({ ...baseState, status: "error" })).toBe(true);
  });

  it("is busy only while something is actually running", () => {
    expect(isDesktopUpdateCheckBusy({ ...baseState, status: "checking" })).toBe(true);
    expect(isDesktopUpdateCheckBusy({ ...baseState, status: "downloading" })).toBe(true);
    // Downloaded means a restart is pending — re-checking would be noise.
    expect(isDesktopUpdateCheckBusy({ ...baseState, status: "downloaded" })).toBe(true);
    expect(isDesktopUpdateCheckBusy({ ...baseState, status: "idle" })).toBe(false);
    expect(isDesktopUpdateCheckBusy({ ...baseState, status: "up-to-date" })).toBe(false);
  });
});

describe("what a finished check says", () => {
  it("says so when there is nothing new", () => {
    // The whole point of the manual control: a check that finds nothing must
    // still answer. Reporting only failures is what made the old Settings
    // button look broken.
    const outcome = describeDesktopUpdateCheck(result(true, { status: "up-to-date" }));
    expect(outcome?.kind).toBe("up-to-date");
    expect(outcome?.title).toContain("1.0.0");
  });

  it("names the version when one is available", () => {
    const outcome = describeDesktopUpdateCheck(result(true, { status: "available", availableVersion: "1.2.0" }));
    expect(outcome?.kind).toBe("available");
    expect(outcome?.title).toContain("1.2.0");
  });

  it("reports an already-downloaded update rather than the check's own result", () => {
    // This check found nothing newer, but a restart away from being updated is
    // the more useful thing to say.
    const outcome = describeDesktopUpdateCheck(result(true, { status: "up-to-date", downloadedVersion: "1.2.0" }));
    expect(outcome?.kind).toBe("downloaded");
    expect(outcome?.description).toContain("Restart");
  });

  it("surfaces the reason a check failed", () => {
    const outcome = describeDesktopUpdateCheck(
      result(true, { status: "error", errorContext: "check", message: "getaddrinfo ENOTFOUND" }),
    );
    expect(outcome?.kind).toBe("error");
    expect(outcome?.description).toContain("ENOTFOUND");
  });

  it("a failed check is not mistaken for nothing having happened", () => {
    // The manager returns checked:true on failure precisely so this reads as
    // an error rather than as an unavailable build.
    const outcome = describeDesktopUpdateCheck(result(true, { status: "error", message: "boom" }));
    expect(outcome?.title).toBe("Could not check for updates");
  });
});

describe("when no check ran", () => {
  it("says the build cannot update itself, rather than claiming to be current", () => {
    const outcome = describeDesktopUpdateCheck(result(false, { enabled: false, status: "disabled" }));
    expect(outcome?.kind).toBe("error");
    expect(outcome?.title).toContain("not available in this build");
  });

  it("stays silent when a check was already in flight", () => {
    // The check already running will report for both; two toasts for one
    // action would be worse than one.
    expect(describeDesktopUpdateCheck(result(false, { status: "checking" }))).toBeNull();
  });
});
