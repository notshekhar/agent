/**
 * Git status and refs.
 *
 * Read-only, deliberately: the panel shows which branch you are on and what has
 * changed, and the agent is the thing that writes. Committing and pushing from
 * the renderer is a larger decision than a status panel, so those RPCs keep
 * failing loudly rather than being quietly half-implemented.
 *
 * Outside the desktop shell there is no git, so `listRefs` reports "not a repo"
 * — the UI polls it unprompted, and a failure there is a visible retry storm —
 * while the status subscription idles.
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  VcsListRefsResult as VcsListRefsResultSchema,
  VcsStatusResult as VcsStatusResultSchema,
  type VcsStatusStreamEvent,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { loopGit, type GitStatus } from "../transport.ts";

const decodeRefs = Schema.decodeUnknownEffect(VcsListRefsResultSchema);
const decodeStatus = Schema.decodeUnknownEffect(VcsStatusResultSchema);

/** How often the status panel re-reads git while a project is open. */
const STATUS_POLL_MS = 5_000;

const malformed = (what: string) =>
  new EnvironmentAuthorizationError({
    message: `git returned an unexpected ${what}`,
    requiredScope: AuthOrchestrationReadScope,
  });

/** What a non-repo, or a browser, looks like. */
const NOT_A_REPO = {
  refs: [],
  isRepo: false,
  hasPrimaryRemote: false,
  nextCursor: null,
  totalCount: 0,
};

export const listRefs = Effect.fnUntraced(function* (input: {
  readonly cwd: string;
  readonly query?: string | undefined;
  readonly refKind?: "all" | "local" | "remote" | undefined;
  readonly limit?: number | undefined;
}) {
  const git = loopGit();
  if (!git) return yield* decodeRefs(NOT_A_REPO).pipe(Effect.mapError(() => malformed("ref list")));

  const result = yield* Effect.promise(() => git.refs(input.cwd));
  const query = input.query?.trim().toLowerCase() ?? "";
  const kind = input.refKind ?? "all";
  const matching = result.refs
    .filter((ref) => (kind === "all" ? true : kind === "remote" ? ref.isRemote : !ref.isRemote))
    .filter((ref) => query === "" || ref.name.toLowerCase().includes(query))
    // The branch you are on, then the default, then the rest alphabetically:
    // the two you are most likely to want are never buried in a long list.
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const limited = input.limit === undefined ? matching : matching.slice(0, input.limit);
  return yield* decodeRefs({
    refs: limited,
    isRepo: result.isRepo,
    hasPrimaryRemote: result.hasPrimaryRemote,
    nextCursor: null,
    totalCount: result.totalCount,
  }).pipe(Effect.mapError(() => malformed("ref list")));
});

const toStatusResult = (status: GitStatus) => ({
  ...status,
  aheadOfDefaultCount: 0,
  pr: null,
});

export const refreshStatus = Effect.fnUntraced(function* (input: { readonly cwd: string }) {
  const git = loopGit();
  if (!git) {
    return yield* decodeStatus({
      ...NOT_A_REPO,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    }).pipe(Effect.mapError(() => malformed("status")));
  }
  const status = yield* Effect.promise(() => git.status(input.cwd));
  return yield* decodeStatus(toStatusResult(status)).pipe(
    Effect.mapError(() => malformed("status")),
  );
});

/**
 * The status subscription: a snapshot now, then a poll.
 *
 * git has no change feed worth the complexity here — a filesystem watcher over
 * a whole repo costs more than re-reading `git status` — so this polls, and
 * only emits when something actually differs so the UI does not re-render on a
 * timer.
 */
export function statusStream(
  cwd: string,
): Stream.Stream<VcsStatusStreamEvent, EnvironmentAuthorizationError> {
  const git = loopGit();
  if (!git) return Stream.never;

  return Stream.callback<VcsStatusStreamEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let previous = "";
        let stopped = false;

        const tick = async () => {
          if (stopped) return;
          try {
            const status = await git.status(cwd);
            const encoded = JSON.stringify(status);
            if (encoded !== previous) {
              previous = encoded;
              const local = await Effect.runPromise(decodeStatus(toStatusResult(status)));
              Queue.offerUnsafe(queue, { _tag: "snapshot", local, remote: null });
            }
          } catch {
            // A transient git failure is not worth tearing the panel down for.
          }
          if (!stopped) timer = setTimeout(tick, STATUS_POLL_MS);
        };

        let timer: ReturnType<typeof setTimeout> | undefined;
        void tick();
        return () => {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.asVoid),
  );
}
