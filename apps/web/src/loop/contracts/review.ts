import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  /**
   * Lines of context around each change. Absent means git's default of three,
   * which shows hunks; a large number shows the whole file with its changes
   * marked inside it, which is what the source-control view asks for.
   */
  contextLines: Schema.optionalKey(Schema.Number),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

/**
 * The kinds the shell can send.
 *
 * `staged` and `unstaged` are the source-control panel's two halves. They must
 * be listed here even though the review pane never selects them: the schema
 * validates the whole result, so one unrecognised `kind` rejects the entire
 * preview and the pane renders "git returned an unexpected diff preview"
 * instead of the diff it was perfectly capable of showing.
 */
export const ReviewDiffPreviewSourceKind = Schema.Literals([
  "working-tree",
  "branch-range",
  "staged",
  "unstaged",
]);
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
