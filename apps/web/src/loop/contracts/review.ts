import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewWorkspaceRepository = Schema.Struct({
  /** Path relative to the folder that was opened, e.g. `group/billing`. */
  path: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  filesChanged: Schema.Int,
  insertions: Schema.Int,
  deletions: Schema.Int,
});
export type ReviewWorkspaceRepository = typeof ReviewWorkspaceRepository.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Wire-shaped on purpose: this crosses the RPC boundary as JSON, so the
  // encoded side has to be a string. Bare `DateTimeUtc` expects a live
  // `DateTime.Utc` instance and rejected the handler's ISO string, which the
  // handler then reported as "git returned an unexpected diff preview" — the
  // review pane never rendered a diff at all.
  generatedAt: Schema.DateTimeUtcFromString,
  sources: Schema.Array(ReviewDiffPreviewSource),
  /**
   * Repositories nested under `cwd`, when `cwd` is a folder of repositories
   * rather than one itself. Absent for an ordinary repo.
   *
   * `sources` is empty alongside this: there is nothing to diff at that level.
   * The panel lists these — the ones with changes first — and asks again with
   * a child's path when one is opened.
   */
  workspaceRepositories: Schema.optional(Schema.Array(ReviewWorkspaceRepository)),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;
