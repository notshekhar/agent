/**
 * Every RPC the vendored UI can make, answered from loop.
 *
 * `WsRpcGroup.toLayer` demands a handler for all 79 RPCs, so a method that has
 * not been ported is a **compile error, not a runtime mystery** — this file is
 * the checklist for the port.
 *
 * Three shapes of answer, and the difference matters:
 *
 *   - implemented — resolves against loop's own JSON-RPC.
 *   - `idle` — a `subscribe*` stream the UI opens as soon as the environment
 *     connects. Failing one tears the connection down before anything renders,
 *     so an unported subscription must idle rather than fail.
 *   - `fail`/`failStream` — a request the user had to trigger. Failing loudly
 *     is right: the feature is visibly unavailable instead of silently dead.
 *
 * `EnvironmentAuthorizationError` is in every RPC's error union, which makes it
 * the one failure shape usable from any handler without widening a contract.
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  OrchestrationDispatchCommandError,
  WsRpcGroup,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { dispatchCommand } from "./dispatch.ts";
import { buildServerConfig, type BuildServerConfigOptions } from "./serverConfig.ts";
import { initialShellItems } from "./shell.ts";
import { threadStream } from "./thread.ts";

const notPorted = (method: string) =>
  new EnvironmentAuthorizationError({
    message: `${method} is not supported by loop's desktop app`,
    requiredScope: AuthOrchestrationReadScope,
  });

const fail = (method: string) => Effect.fail(notPorted(method));
const failStream = (method: string) => Stream.fail(notPorted(method));
/** A subscription that stays open and never emits. */
const idle = () => Stream.never;

export interface HandlerOptions extends BuildServerConfigOptions {}

export const makeHandlers = (options: HandlerOptions) =>
  WsRpcGroup.toLayer({
    "server.probe": () => Effect.succeed({}),

    "server.getConfig": () =>
      buildServerConfig(options).pipe(
        Effect.mapError(
          () =>
            new EnvironmentAuthorizationError({
              message: "loop could not describe this environment",
              requiredScope: AuthOrchestrationReadScope,
            }),
        ),
      ),

    // One snapshot, then hold the stream open. loop pushes config changes
    // through its own settings RPCs, not through this channel.
    subscribeServerConfig: () =>
      Stream.fromEffect(
        buildServerConfig(options).pipe(
          Effect.map((config) => ({ version: 1 as const, type: "snapshot" as const, config })),
          Effect.mapError(
            () =>
              new EnvironmentAuthorizationError({
                message: "loop could not describe this environment",
                requiredScope: AuthOrchestrationReadScope,
              }),
          ),
        ),
      ).pipe(Stream.concat(Stream.never)),

  "server.upsertKeybinding": () => fail("server.upsertKeybinding"),
  "server.removeKeybinding": () => fail("server.removeKeybinding"),
  "server.refreshProviders": () => fail("server.refreshProviders"),
  "server.updateProvider": () => fail("server.updateProvider"),
  "server.updateServer": () => fail("server.updateServer"),
  "server.updateServerWithProgress": () => failStream("server.updateServerWithProgress"),
  "server.getSettings": () => fail("server.getSettings"),
  "server.updateSettings": () => fail("server.updateSettings"),
  "server.discoverSourceControl": () => fail("server.discoverSourceControl"),
  "server.getTraceDiagnostics": () => fail("server.getTraceDiagnostics"),
  "server.getProcessDiagnostics": () => fail("server.getProcessDiagnostics"),
  "server.getProcessResourceHistory": () => fail("server.getProcessResourceHistory"),
  "server.getResourceTelemetryHistory": () => fail("server.getResourceTelemetryHistory"),
  "server.retryResourceTelemetry": () => fail("server.retryResourceTelemetry"),
  "server.signalProcess": () => fail("server.signalProcess"),
  "cloud.getRelayClientStatus": () => fail("cloud.getRelayClientStatus"),
  "cloud.installRelayClient": () => failStream("cloud.installRelayClient"),
  "server.reportClientActivity": () => fail("server.reportClientActivity"),
  "server.reportHostPowerState": () => fail("server.reportHostPowerState"),
  "server.getBackgroundPolicy": () => fail("server.getBackgroundPolicy"),
  "sourceControl.lookupRepository": () => fail("sourceControl.lookupRepository"),
  "sourceControl.cloneRepository": () => fail("sourceControl.cloneRepository"),
  "sourceControl.publishRepository": () => fail("sourceControl.publishRepository"),
  "projects.searchEntries": () => fail("projects.searchEntries"),
  "projects.searchContents": () => fail("projects.searchContents"),
  "projects.listEntries": () => fail("projects.listEntries"),
  "projects.readFile": () => fail("projects.readFile"),
  "projects.writeFile": () => fail("projects.writeFile"),
  "shell.openInEditor": () => fail("shell.openInEditor"),
  "filesystem.browse": () => fail("filesystem.browse"),
  "assets.createUrl": () => fail("assets.createUrl"),
  "subscribeVcsStatus": idle,
  "vcs.pull": () => fail("vcs.pull"),
  "vcs.refreshStatus": () => fail("vcs.refreshStatus"),
  "git.runStackedAction": () => failStream("git.runStackedAction"),
  "git.resolvePullRequest": () => fail("git.resolvePullRequest"),
  "git.preparePullRequestThread": () => fail("git.preparePullRequestThread"),
    // Git is not backed yet. The UI polls this on its own — nobody asked for
    // it — and a failure here puts it into a visible retry loop, so report
    // "this is not a repo" instead. User-triggered git actions below still
    // fail loudly, because there the user is owed an answer.
    "vcs.listRefs": () =>
      Effect.succeed({
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      }),
  "vcs.createWorktree": () => fail("vcs.createWorktree"),
  "vcs.removeWorktree": () => fail("vcs.removeWorktree"),
  "vcs.createRef": () => fail("vcs.createRef"),
  "vcs.switchRef": () => fail("vcs.switchRef"),
  "vcs.init": () => fail("vcs.init"),
  "review.getDiffPreview": () => fail("review.getDiffPreview"),
  "terminal.open": () => fail("terminal.open"),
  "terminal.attach": () => failStream("terminal.attach"),
  "terminal.write": () => fail("terminal.write"),
  "terminal.resize": () => fail("terminal.resize"),
  "terminal.clear": () => fail("terminal.clear"),
  "terminal.restart": () => fail("terminal.restart"),
  "terminal.close": () => fail("terminal.close"),
  "preview.open": () => fail("preview.open"),
  "preview.navigate": () => fail("preview.navigate"),
  "preview.resize": () => fail("preview.resize"),
  "preview.refresh": () => fail("preview.refresh"),
  "preview.close": () => fail("preview.close"),
  "preview.list": () => fail("preview.list"),
  "preview.reportStatus": () => fail("preview.reportStatus"),
  "previewAutomation.connect": () => failStream("previewAutomation.connect"),
  "previewAutomation.respond": () => fail("previewAutomation.respond"),
  "previewAutomation.focusHost": () => fail("previewAutomation.focusHost"),
  "subscribePreviewEvents": idle,
  "subscribeDiscoveredLocalServers": idle,
    "orchestration.dispatchCommand": (command) =>
      dispatchCommand(command).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            new OrchestrationDispatchCommandError({
              message: `loop could not run ${command.type}`,
              cause,
            }),
          ),
        ),
      ),
  "orchestration.getTurnDiff": () => fail("orchestration.getTurnDiff"),
  "orchestration.getFullThreadDiff": () => fail("orchestration.getFullThreadDiff"),
  "orchestration.searchThreads": () => fail("orchestration.searchThreads"),
  "orchestration.getArchivedShellSnapshot": () => fail("orchestration.getArchivedShellSnapshot"),
    // Projects and threads, derived from loop's sessions. Emits the snapshot
    // and the completion marker the client waits on, then holds the stream
    // open — loop pushes no shell deltas, so a re-subscribe is the refresh.
    "orchestration.subscribeShell": () =>
      Stream.fromEffect(
        initialShellItems().pipe(
          Effect.mapError(
            () =>
              new EnvironmentAuthorizationError({
                message: "loop could not list its sessions",
                requiredScope: AuthOrchestrationReadScope,
              }),
          ),
        ),
      ).pipe(Stream.flattenIterable, Stream.concat(Stream.never)),
    // A snapshot now, then a fresh one whenever the live turn moves. loop's
    // event vocabulary (text-delta, tool-call, reasoning) does not line up
    // one-for-one with the contract's command-echo events, so re-deriving the
    // whole thread is both simpler and impossible to get subtly out of sync.
    // The rebuild is coalesced, or a fast model would rebuild per token.
    "orchestration.subscribeThread": (input) => threadStream(input.threadId),
  "subscribeTerminalEvents": idle,
  "subscribeTerminalMetadata": idle,
  "subscribeServerLifecycle": idle,
  "subscribeAuthAccess": idle,
  "subscribeBackgroundPolicy": idle,
  "subscribeResourceTelemetry": idle,
  });
