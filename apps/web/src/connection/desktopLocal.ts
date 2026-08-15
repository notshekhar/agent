import type { ConnectionTarget } from "@loop/runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
} from "@loop/contracts";

/**
 * Desktop-local secondary backends (e.g. a parallel WSL backend) are registered
 * by the connection platform source as bearer connections whose id carries this
 * prefix. It is the renderer's single signal that an environment is a
 * host-managed local backend rather than a user-saved remote, SSH, or relay
 * environment.
 *
 * Keep this the one source of truth: the producer (`connection/platform.ts`)
 * mints ids via {@link desktopLocalConnectionId} and every consumer classifies
 * via {@link isDesktopLocalConnectionTarget}, so the convention can never drift
 * between the two.
 */
export const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

export function desktopLocalConnectionId(backendId: string): string {
  return `${DESKTOP_LOCAL_CONNECTION_ID_PREFIX}${backendId}`;
}

export function isDesktopLocalConnectionTarget(
  target: ConnectionTarget,
): target is Extract<ConnectionTarget, { readonly _tag: "BearerConnectionTarget" }> {
  return (
    target._tag === "BearerConnectionTarget" &&
    target.connectionId.startsWith(DESKTOP_LOCAL_CONNECTION_ID_PREFIX)
  );
}

export function desktopLocalBackendId(target: ConnectionTarget): string | null {
  return isDesktopLocalConnectionTarget(target)
    ? target.connectionId.slice(DESKTOP_LOCAL_CONNECTION_ID_PREFIX.length)
    : null;
}

export type DesktopSecondaryBootstrapsRead =
  | {
      readonly _tag: "Success";
      readonly bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap>;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export interface DesktopSecondaryBootstrapsReader {
  readonly readResult: () => DesktopSecondaryBootstrapsRead;
  readonly readSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
}

/**
 * Whether two reads describe the same topology.
 *
 * The bridge answers every call with fresh objects over IPC, so neither the
 * array nor its entries survive `===` even when nothing has changed. Without a
 * value comparison the 2s poll in `useDesktopLocalBootstraps` hands React a new
 * identity every tick and re-renders its consumers — the command palette among
 * them — forever, for a topology that changes when a backend is added.
 *
 * DesktopEnvironmentBootstrap is flat, so field-wise is exact.
 */
const EMPTY_BOOTSTRAPS: ReadonlyArray<DesktopEnvironmentBootstrap> = [];

function sameBootstrap(a: DesktopEnvironmentBootstrap, b: DesktopEnvironmentBootstrap): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.runningDistro === b.runningDistro &&
    a.httpBaseUrl === b.httpBaseUrl &&
    a.wsBaseUrl === b.wsBaseUrl &&
    a.bootstrapToken === b.bootstrapToken
  );
}

function sameBootstraps(
  a: ReadonlyArray<DesktopEnvironmentBootstrap>,
  b: ReadonlyArray<DesktopEnvironmentBootstrap>,
): boolean {
  return a.length === b.length && a.every((entry, index) => sameBootstrap(entry, b[index]!));
}

/**
 * Build a topology reader whose snapshot advances only after successful bridge
 * reads. A successful empty read is authoritative; a thrown read preserves the
 * previous snapshot so UI consumers cannot temporarily disagree with the
 * platform's retained registrations.
 */
export function createDesktopSecondaryBootstrapsReader(
  resolveBridge: () => Pick<DesktopBridge, "getLocalEnvironmentBootstraps"> | undefined,
): DesktopSecondaryBootstrapsReader {
  let snapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = EMPTY_BOOTSTRAPS;

  const readResult = (): DesktopSecondaryBootstrapsRead => {
    const bridge = resolveBridge();
    if (bridge === undefined) {
      // A shared empty, not a fresh one: on the web there is never a bridge, so
      // this is the path every poll takes. See sameBootstraps.
      if (snapshot.length > 0) snapshot = EMPTY_BOOTSTRAPS;
      return { _tag: "Success", bootstraps: snapshot };
    }
    try {
      const next = bridge
        .getLocalEnvironmentBootstraps()
        .filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
      // Hold the previous array when the topology is unchanged, so consumers
      // polling this can compare by identity. See sameBootstraps.
      if (!sameBootstraps(snapshot, next)) snapshot = next;
      return { _tag: "Success", bootstraps: snapshot };
    } catch (cause) {
      return { _tag: "Failure", cause };
    }
  };

  return {
    readResult,
    readSnapshot: () => {
      const result = readResult();
      return result._tag === "Success" ? result.bootstraps : snapshot;
    },
  };
}

const desktopSecondaryBootstrapsReader = createDesktopSecondaryBootstrapsReader(
  () => window.desktopBridge,
);

/** Read the topology while preserving failures for platform cache policy. */
export function readDesktopSecondaryBootstrapsResult(): DesktopSecondaryBootstrapsRead {
  return desktopSecondaryBootstrapsReader.readResult();
}

/** Read the latest successful topology snapshot for renderer consumers. */
export function readDesktopSecondaryBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return desktopSecondaryBootstrapsReader.readSnapshot();
}
