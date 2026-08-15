import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@loop/runtime/connection";
import { EnvironmentId, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@loop/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createDesktopSecondaryBootstrapsReader,
  desktopLocalBackendId,
  desktopLocalConnectionId,
  isDesktopLocalConnectionTarget,
} from "./desktopLocal";

describe("desktop local connection identity", () => {
  it("preserves the desktop backend instance id", () => {
    const target = new BearerConnectionTarget({
      connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
      environmentId: EnvironmentId.make("environment-wsl"),
      label: "WSL (Ubuntu)",
    });

    expect(isDesktopLocalConnectionTarget(target)).toBe(true);
    expect(desktopLocalBackendId(target)).toBe("wsl:Ubuntu");
  });

  it("does not classify the primary environment as desktop-local", () => {
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-primary"),
      httpBaseUrl: "http://127.0.0.1:3773",
      label: "This device",
      wsBaseUrl: "ws://127.0.0.1:3773",
    });

    expect(isDesktopLocalConnectionTarget(target)).toBe(false);
    expect(desktopLocalBackendId(target)).toBeNull();
  });
});

describe("desktop local topology reads", () => {
  it("distinguishes a successful empty topology from a read failure", () => {
    let readBootstraps = () => [];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => readBootstraps(),
    }));

    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: [] });

    const cause = new Error("IPC unavailable");
    readBootstraps = () => {
      throw cause;
    };
    expect(reader.readResult()).toEqual({ _tag: "Failure", cause });
  });

  it("filters the primary bootstrap from successful topology reads", () => {
    const secondary = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };

    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => [
        {
          ...secondary,
          id: PRIMARY_LOCAL_ENVIRONMENT_ID,
          label: "Windows",
        },
        secondary,
      ],
    }));

    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: [secondary] });
  });

  it("retains the last successful snapshot only until another read succeeds", () => {
    const secondary = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };
    let readBootstraps = () => [secondary];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => readBootstraps(),
    }));

    const connectedSnapshot = reader.readSnapshot();
    expect(connectedSnapshot).toEqual([secondary]);

    readBootstraps = () => {
      throw new Error("IPC unavailable");
    };
    expect(reader.readSnapshot()).toBe(connectedSnapshot);

    readBootstraps = () => [];
    const removedSnapshot = reader.readSnapshot();
    expect(removedSnapshot).toEqual([]);

    readBootstraps = () => {
      throw new Error("IPC unavailable again");
    };
    expect(reader.readSnapshot()).toBe(removedSnapshot);
  });

  /**
   * The bridge answers with fresh objects every call, so an unchanged topology
   * still arrives as a new array. Consumers poll this on an interval and feed
   * the result to React, so a snapshot that changes identity for no reason
   * re-renders them every tick — see useDesktopLocalBootstraps.
   */
  it("holds snapshot identity while the topology is unchanged", () => {
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      // Fresh objects each call, as the real IPC bridge returns.
      getLocalEnvironmentBootstraps: () => [
        {
          id: "wsl:Ubuntu",
          label: "WSL: Ubuntu",
          httpBaseUrl: "http://127.0.0.1:4000",
          wsBaseUrl: "ws://127.0.0.1:4000",
        },
      ],
    }));

    expect(reader.readSnapshot()).toBe(reader.readSnapshot());
  });

  it("holds identity when there is no desktop bridge at all", () => {
    const reader = createDesktopSecondaryBootstrapsReader(() => undefined);

    expect(reader.readSnapshot()).toBe(reader.readSnapshot());
  });

  it("advances identity when the topology actually changes", () => {
    const secondary = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };
    let readBootstraps = () => [secondary];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => readBootstraps(),
    }));

    const before = reader.readSnapshot();
    readBootstraps = () => [{ ...secondary, label: "WSL: Ubuntu (renamed)" }];
    const after = reader.readSnapshot();

    expect(after).not.toBe(before);
    expect(after[0]?.label).toBe("WSL: Ubuntu (renamed)");
  });
});
