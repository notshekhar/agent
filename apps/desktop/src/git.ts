/**
 * Git, by shelling out.
 *
 * Third capability the shell provides and loop's RPC does not. Everything here
 * is read-only on purpose: the app shows you branches and what has changed,
 * and the agent is the thing that writes. A `git` that can commit and push
 * from the renderer is a much bigger decision than a status panel.
 *
 * `git` is spawned with argv arrays and never a shell string, so a branch
 * called `; rm -rf /` is a branch name rather than a command.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Bounded so a pathological repo cannot wedge the main process. */
const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * How many `git` processes this module may have in flight at once.
 *
 * Not a politeness limit — a latency one. `uv_spawn` is a BLOCKING syscall on
 * the calling thread, and the calling thread here is the one running loop's
 * core: the agent turn, its tool calls, the session writes, every PTY byte and
 * every IPC reply. A `Promise.all` over N spawns is therefore N fork/execs
 * back to back with no yield in between, and the whole window is dead air for
 * the running thread.
 *
 * That is exactly what the fan-outs below used to do — `untrackedPatch` up to
 * `MAX_UNTRACKED_FILES`, `workspaceStatus` and `workspaceDiffPreview` up to
 * `WORKSPACE_REPO_LIMIT` repositories times ~6 commands each. Opening the diff
 * panel mid-turn stalled the agent, which is what "the session gets stuck"
 * was.
 *
 * MEASURED (10-core M-series, 200 spawns of `git --version`):
 *
 *   unbounded  wall 229ms   worst event-loop stall 217ms
 *   pool of 4  wall 287ms   worst event-loop stall   3ms
 *   pool of 8  wall 200ms   worst event-loop stall   3ms
 *   pool of 16 wall 184ms   worst event-loop stall   8ms
 *   pool of 32 wall 203ms   worst event-loop stall  27ms
 *
 * Eight is where wall-clock bottoms out — the bounded run is FASTER than the
 * unbounded one, because 200 simultaneous forks contend more than they
 * parallelise. Past 12 the stall grows again and buys nothing. So this costs
 * no throughput; it only stops the burst from being one unbroken block.
 */
export const MAX_CONCURRENT_GIT = 8;

let activeGitProcesses = 0;
const waitingForGitSlot: Array<() => void> = [];

/**
 * Run `work` with a spawn slot held.
 *
 * A release HANDS ITS SLOT to the next waiter rather than decrementing and
 * signalling. Decrementing first opens a window — the waiter only resumes on a
 * later microtask, and a caller arriving in between sees a count below the
 * limit, takes the slot, and then the waiter increments on top of it. The pool
 * ratchets past its own ceiling, one process per contended release, which is
 * precisely the burst this exists to prevent.
 *
 * Transferring also keeps the queue honestly FIFO: while anyone is waiting the
 * count is pinned at the limit, so a newcomer always queues behind them
 * instead of barging a slot a waiter was already promised.
 *
 * The release sits in a `finally` so a throwing or timing-out command cannot
 * leak a slot and shrink the pool for the rest of the session.
 */
export async function withGitSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeGitProcesses >= MAX_CONCURRENT_GIT) {
    await new Promise<void>((resolve) => waitingForGitSlot.push(resolve));
    // The slot came with the wakeup; the count already counts us.
  } else {
    activeGitProcesses += 1;
  }
  try {
    return await work();
  } finally {
    const next = waitingForGitSlot.shift();
    if (next) next();
    else activeGitProcesses -= 1;
  }
}

/**
 * Read a git command's stdout, or null if it failed.
 *
 * Exported for `gitActions.ts`, which owns the writes: the two modules must
 * agree on the environment (`GIT_PAGER`, `GIT_OPTIONAL_LOCKS`) or a write would
 * see a different repo view than the panel showing it.
 */
export async function readGit(cwd: string, args: readonly string[]): Promise<string | null> {
  return git(cwd, args);
}

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await withGitSlot(() =>
      run("git", [...args], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        // A pager would never return; git turns it off when not a TTY, but an
        // explicit -c is the only guarantee across user configs.
        env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
      }),
    );
    return stdout;
  } catch {
    // A non-zero exit is an answer, not a crash: "not a repo", "no upstream",
    // "no such ref" all arrive this way and each has a sensible empty result.
    return null;
  }
}

/**
 * A folder holding repositories, which is not itself one.
 *
 * A very common way to work: `~/work` with a dozen micro-services under it,
 * each its own repository and the parent deliberately not. Opened as a
 * project, every git-shaped surface reported "not a repository" and the diff
 * panel was simply unavailable — the changes were all one level down, and
 * nothing looked there.
 *
 * Two levels deep, because services are often grouped (`~/work/payments/api`),
 * and no deeper: past that the walk costs more than it finds. A directory that
 * IS a repository is never descended into — its submodules belong to it.
 */
const WORKSPACE_REPO_MAX_DEPTH = 2;
const WORKSPACE_REPO_LIMIT = 50;
/** Never worth a stat: none of these hold a project's repositories. */
const NON_REPO_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
]);

async function isRepositoryRoot(directory: string): Promise<boolean> {
  try {
    // A worktree's `.git` is a file, not a directory, so `stat` alone answers.
    await stat(join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Repositories nested under `root`, as paths relative to it.
 *
 * Sorted so the panel's ordering is stable between reads — an unsorted
 * `readdir` reshuffles the diff on every poll.
 */
export async function workspaceRepositories(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > WORKSPACE_REPO_MAX_DEPTH || found.length >= WORKSPACE_REPO_LIMIT) return;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (found.length >= WORKSPACE_REPO_LIMIT) return;
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      if (child.name.startsWith(".") || NON_REPO_DIRECTORIES.has(child.name)) continue;
      const absolute = join(directory, child.name);
      const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (await isRepositoryRoot(absolute)) {
        found.push(relative);
        continue;
      }
      await walk(absolute, relative, depth + 1);
    }
  };
  await walk(root, "", 1);
  return found.sort((a, b) => a.localeCompare(b));
}

export interface GitRef {
  readonly name: string;
  readonly isRemote: boolean;
  readonly remoteName?: string;
  readonly current: boolean;
  readonly isDefault: boolean;
  readonly worktreePath: string | null;
}

export interface GitRefs {
  readonly refs: readonly GitRef[];
  readonly isRepo: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly totalCount: number;
}

/** The branch the remote's HEAD points at, else the conventional fallbacks. */
async function defaultBranch(cwd: string, names: ReadonlySet<string>): Promise<string | null> {
  const head = await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const fromRemote = head?.trim().replace(/^origin\//, "");
  if (fromRemote) return fromRemote;
  for (const candidate of ["main", "master"]) if (names.has(candidate)) return candidate;
  return null;
}

export async function listRefs(cwd: string): Promise<GitRefs> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") {
    return { refs: [], isRepo: false, hasPrimaryRemote: false, totalCount: 0 };
  }

  const [branchOutput, remoteOutput, worktreeOutput] = await Promise.all([
    // %(HEAD) is "*" for the checked-out branch — cheaper and more reliable
    // than a second rev-parse, and correct in a detached worktree.
    git(cwd, [
      "for-each-ref",
      "--format=%(HEAD)%09%(refname:short)%09%(refname:rstrip=-2)",
      "refs/heads",
      "refs/remotes",
    ]),
    git(cwd, ["remote"]),
    git(cwd, ["worktree", "list", "--porcelain"]),
  ]);

  const worktreeByBranch = new Map<string, string>();
  let currentWorktree: string | null = null;
  for (const line of (worktreeOutput ?? "").split("\n")) {
    if (line.startsWith("worktree ")) currentWorktree = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && currentWorktree) {
      worktreeByBranch.set(line.slice("branch refs/heads/".length).trim(), currentWorktree);
    }
  }

  const rows = (branchOutput ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [head = "", name = "", kind = ""] = line.split("\t");
      return { current: head === "*", name, isRemote: kind === "refs/remotes" };
    })
    // origin/HEAD is a symbolic alias, not a branch anyone means to check out.
    .filter((row) => row.name !== "" && !row.name.endsWith("/HEAD"));

  const localNames = new Set(rows.filter((row) => !row.isRemote).map((row) => row.name));
  const fallbackDefault = await defaultBranch(cwd, localNames);

  const refs: GitRef[] = rows.map((row) => {
    const remoteName = row.isRemote ? row.name.slice(0, row.name.indexOf("/")) : undefined;
    return {
      name: row.name,
      isRemote: row.isRemote,
      ...(remoteName === undefined ? {} : { remoteName }),
      current: row.current,
      isDefault: !row.isRemote && row.name === fallbackDefault,
      worktreePath: worktreeByBranch.get(row.name) ?? null,
    };
  });

  return {
    refs,
    isRepo: true,
    hasPrimaryRemote: (remoteOutput ?? "").trim() !== "",
    totalCount: refs.length,
  };
}

export interface GitStatus {
  readonly isRepo: boolean;
  /** Reported a repo only because it CONTAINS repositories — see
   * `workspaceStatus`. Absent on a real single repository. */
  readonly isWorkspaceRoot?: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly isDefaultRef: boolean;
  readonly refName: string | null;
  readonly hasWorkingTreeChanges: boolean;
  readonly workingTree: {
    readonly files: ReadonlyArray<{ path: string; insertions: number; deletions: number }>;
    readonly insertions: number;
    readonly deletions: number;
  };
  readonly hasUpstream: boolean;
  readonly aheadCount: number;
  readonly behindCount: number;
}

const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
};

/**
 * One status for a folder full of repositories.
 *
 * Reported as a repo so the panels that read this — the diff surface above all
 * — become available, with every changed path qualified by the repository it
 * came from. The single-repo fields stay off deliberately: there is no one
 * branch, no one remote, and no upstream to be ahead of, and claiming
 * otherwise would offer a push that has no repository to run in.
 */
async function workspaceStatus(cwd: string, repositories: readonly string[]): Promise<GitStatus> {
  const perRepo = await Promise.all(
    repositories.map(async (repository) => ({
      repository,
      status: await status(join(cwd, repository)),
    })),
  );

  const files: Array<{ path: string; insertions: number; deletions: number }> = [];
  let insertions = 0;
  let deletions = 0;
  const branches = new Set<string>();
  for (const { repository, status: child } of perRepo) {
    if (!child.isRepo) continue;
    if (child.refName) branches.add(child.refName);
    insertions += child.workingTree.insertions;
    deletions += child.workingTree.deletions;
    for (const file of child.workingTree.files) {
      files.push({ ...file, path: `${repository}/${file.path}` });
    }
  }

  return {
    isRepo: true,
    // Says WHY isRepo is true, which the caller cannot otherwise tell: this
    // folder has no branch of its own, and without the flag a reader takes
    // `refName: null` for a detached HEAD and offers to check a branch out.
    isWorkspaceRoot: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    // Only when every repository agrees; otherwise there is no honest name.
    refName: branches.size === 1 ? [...branches][0]! : null,
    hasWorkingTreeChanges: files.length > 0,
    workingTree: { files, insertions, deletions },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
  };
}

export async function status(cwd: string): Promise<GitStatus> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") {
    const repositories = await workspaceRepositories(cwd);
    return repositories.length > 0 ? workspaceStatus(cwd, repositories) : EMPTY_STATUS;
  }

  const [branch, remotes, numstat, untracked, upstream] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["remote"]),
    // HEAD covers staged and unstaged together, which is what "what has
    // changed since the last commit" means to someone reading the panel.
    git(cwd, ["diff", "--numstat", "HEAD"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard"]),
    git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  ]);

  const files: Array<{ path: string; insertions: number; deletions: number }> = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of (numstat ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const [added = "", removed = "", path = ""] = line.split("\t");
    if (path === "") continue;
    // "-" is git's marker for a binary file; it has no line counts.
    const plus = added === "-" ? 0 : Number.parseInt(added, 10) || 0;
    const minus = removed === "-" ? 0 : Number.parseInt(removed, 10) || 0;
    insertions += plus;
    deletions += minus;
    files.push({ path, insertions: plus, deletions: minus });
  }
  for (const path of (untracked ?? "").split("\n")) {
    if (path.trim() !== "") files.push({ path, insertions: 0, deletions: 0 });
  }

  const [behindRaw = "0", aheadRaw = "0"] = (upstream ?? "").trim().split(/\s+/);
  const refName = branch?.trim() || null;
  const localNames = refName ? new Set([refName]) : new Set<string>();

  return {
    isRepo: true,
    hasPrimaryRemote: (remotes ?? "").trim() !== "",
    isDefaultRef: refName !== null && refName === (await defaultBranch(cwd, localNames)),
    refName,
    hasWorkingTreeChanges: files.length > 0,
    workingTree: { files, insertions, deletions },
    // `upstream` is null when @{upstream} does not resolve — no tracking branch.
    hasUpstream: upstream !== null,
    aheadCount: Number.parseInt(aheadRaw, 10) || 0,
    behindCount: Number.parseInt(behindRaw, 10) || 0,
  };
}

/**
 * A patch, with truncation reported rather than thrown.
 *
 * The readers above collapse every failure into `null`, which is right for
 * "what branch am I on" but wrong for a diff: `git diff --no-index` exits 1
 * whenever the files differ, which is the only case that produces output at
 * all. So this keeps stdout on a non-zero exit, and caps the patch itself —
 * a 40MB diff is not something the review pane can render, and shipping it
 * over IPC would freeze the window before it tried.
 */
async function patch(
  cwd: string,
  args: readonly string[],
  maxBytes: number,
): Promise<{ diff: string; truncated: boolean }> {
  let stdout: string;
  try {
    ({ stdout } = await withGitSlot(() =>
      run("git", [...args], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
      }),
    ));
  } catch (error) {
    // A diff that found differences, a diff that overflowed the buffer, and a
    // diff that failed outright all land here; the first two still carry the
    // part of the patch git managed to write.
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  if (stdout.length <= maxBytes) return { diff: stdout, truncated: false };
  // Cut on a line boundary: half a hunk header parses as garbage.
  const cut = stdout.lastIndexOf("\n", maxBytes);
  return { diff: stdout.slice(0, cut > 0 ? cut : maxBytes), truncated: true };
}

/** How much of each patch survives the trip to the renderer. */
const MAX_TRACKED_DIFF_BYTES = 400_000;
const MAX_UNTRACKED_DIFF_BYTES = 120_000;
/** Untracked files are diffed one process each, so the count is bounded too. */
const MAX_UNTRACKED_FILES = 200;

const PATCH_FLAGS = [
  "--patch",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--minimal",
] as const;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Branches worth guessing at when nothing configured says what the base is. */
const BASE_BRANCH_CANDIDATES = ["main", "master", "develop"] as const;

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== null;
}

/**
 * What "the branch changes" are measured against.
 *
 * The upstream is the honest answer when there is one. Without it this walks
 * the same ladder t3code's server does — an explicitly configured merge base,
 * then the remote's default branch, then the conventional names — preferring
 * the remote copy of each, because a stale local `main` makes the diff claim
 * changes that were merged weeks ago.
 */
export async function baseBranchFor(cwd: string, branch: string | null): Promise<string | null> {
  if (!branch) return null;

  const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const tracked = upstream?.trim();
  // A branch tracking its own remote copy would diff against itself.
  if (tracked && tracked !== `origin/${branch}` && (await refExists(cwd, tracked))) return tracked;

  const configured = (await git(cwd, ["config", "--get", `branch.${branch}.gh-merge-base`]))?.trim();
  const fromRemote = await defaultBranch(cwd, new Set<string>());
  for (const raw of [configured, fromRemote, ...BASE_BRANCH_CANDIDATES]) {
    const candidate = raw?.replace(/^origin\//, "").trim();
    if (!candidate || candidate === branch) continue;
    if (await refExists(cwd, `origin/${candidate}`)) return `origin/${candidate}`;
    if (await refExists(cwd, candidate)) return candidate;
  }
  return null;
}

/** Untracked files, as patches against nothing — git omits them from `diff`. */
async function untrackedPatch(cwd: string): Promise<{ diff: string; truncated: boolean }> {
  const listed = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = (listed ?? "").split("\0").filter((path) => path !== "");
  if (paths.length === 0) return { diff: "", truncated: false };

  const capped = paths.slice(0, MAX_UNTRACKED_FILES);
  const patches = await Promise.all(
    capped.map((path) =>
      patch(
        cwd,
        ["diff", "--no-index", ...PATCH_FLAGS, "--", devNull, path],
        MAX_UNTRACKED_DIFF_BYTES,
      ),
    ),
  );
  return {
    diff: patches
      .map((result) => result.diff.trimEnd())
      .filter((diff) => diff !== "")
      .join("\n"),
    truncated: capped.length < paths.length || patches.some((result) => result.truncated),
  };
}

export interface GitDiffPreviewSource {
  readonly id: string;
  readonly kind: "working-tree" | "branch-range";
  readonly title: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly diff: string;
  readonly diffHash: string;
  readonly truncated: boolean;
}

/** One row of the repository list a folder-of-repositories shows. */
export interface GitWorkspaceRepository {
  readonly path: string;
  readonly branch: string | null;
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface GitDiffPreview {
  readonly isRepo: boolean;
  readonly sources: readonly GitDiffPreviewSource[];
  /**
   * Set only when `cwd` holds repositories rather than being one. `sources` is
   * empty in that case — the panel lists these and asks again per repository.
   */
  readonly workspaceRepositories?: readonly GitWorkspaceRepository[];
}

/**
 * The two patches the review pane switches between.
 *
 * "Working tree" is everything since the last commit — staged and unstaged
 * together, plus untracked files, because "what has changed" does not mean
 * "what I remembered to `git add`". "Branch changes" is `base...HEAD`, the
 * three-dot form, so commits that landed on the base after this branch started
 * do not show up as changes this branch made.
 *
 * Both are always returned, even empty: the pane keeps its two tabs and shows
 * "no changes" rather than losing one of them.
 */
interface RepoPatches {
  readonly branch: string | null;
  readonly baseRef: string | null;
  readonly workingTree: string;
  readonly workingTreeTruncated: boolean;
  readonly range: string;
  readonly rangeTruncated: boolean;
}

/** Both patches for one repository: the working tree, and the branch range. */
async function repoPatches(
  cwd: string,
  options: { readonly baseRef?: string; readonly ignoreWhitespace?: boolean },
): Promise<RepoPatches> {
  const whitespace = options.ignoreWhitespace ? ["--ignore-all-space"] : [];
  const branch = (await git(cwd, ["branch", "--show-current"]))?.trim() || null;
  const baseRef = options.baseRef?.trim() || (await baseBranchFor(cwd, branch));

  const [tracked, untracked, range] = await Promise.all([
    patch(
      cwd,
      ["diff", ...PATCH_FLAGS, ...whitespace, "HEAD", "--"],
      MAX_TRACKED_DIFF_BYTES,
    ),
    untrackedPatch(cwd),
    baseRef
      ? patch(
          cwd,
          ["diff", ...PATCH_FLAGS, ...whitespace, `${baseRef}...HEAD`],
          MAX_TRACKED_DIFF_BYTES,
        )
      : Promise.resolve({ diff: "", truncated: false }),
  ]);

  return {
    branch,
    baseRef,
    workingTree: [tracked.diff.trimEnd(), untracked.diff.trimEnd()]
      .filter((diff) => diff !== "")
      .join("\n"),
    workingTreeTruncated: tracked.truncated || untracked.truncated,
    range: range.diff,
    rangeTruncated: range.truncated,
  };
}

function diffSources(input: {
  readonly workingTree: string;
  readonly workingTreeTruncated: boolean;
  readonly range: string;
  readonly rangeTruncated: boolean;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly rangeTitle: string;
}): GitDiffPreview {
  return {
    isRepo: true,
    sources: [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Working tree",
        baseRef: "HEAD",
        headRef: null,
        diff: input.workingTree,
        diffHash: sha256(input.workingTree),
        truncated: input.workingTreeTruncated,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: input.rangeTitle,
        baseRef: input.baseRef,
        headRef: input.headRef,
        diff: input.range,
        diffHash: sha256(input.range),
        truncated: input.rangeTruncated,
      },
    ],
  };
}

export async function diffPreview(
  cwd: string,
  options: { readonly baseRef?: string; readonly ignoreWhitespace?: boolean } = {},
): Promise<GitDiffPreview> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return workspaceDiffPreview(cwd);

  const repo = await repoPatches(cwd, options);
  return diffSources({
    ...repo,
    headRef: repo.branch ?? "HEAD",
    rangeTitle: repo.baseRef ? `Against ${repo.baseRef}` : "Against base branch",
  });
}

/**
 * What a folder of repositories offers instead of a diff: the repositories.
 *
 * Concatenating every child's patch was the obvious first move and the wrong
 * one. Thirty-four repositories came to 17k added lines, blew past the preview
 * cap, and arrived as one undifferentiated wall the panel had to parse on the
 * main thread — slow to open and impossible to read.
 *
 * So this reads only what a list needs: each repository's branch and change
 * counts, which is a `numstat` and an `ls-files`, no patch text at all. The
 * panel renders that list, and asks for a real diff — through the ordinary
 * single-repository path — only for the one the user opens.
 *
 * Repositories with changes sort first, largest first, because those are the
 * ones being looked for; the quiet ones stay listed underneath in name order.
 */
async function workspaceDiffPreview(cwd: string): Promise<GitDiffPreview> {
  const repositories = await workspaceRepositories(cwd);
  if (repositories.length === 0) return { isRepo: false, sources: [] };

  const rows = await Promise.all(
    repositories.map(async (repository): Promise<GitWorkspaceRepository> => {
      const child = await status(join(cwd, repository)).catch(() => null);
      return {
        path: repository,
        branch: child?.refName ?? null,
        filesChanged: child?.workingTree.files.length ?? 0,
        insertions: child?.workingTree.insertions ?? 0,
        deletions: child?.workingTree.deletions ?? 0,
      };
    }),
  );

  const ordered = rows.toSorted((left, right) => {
    if ((left.filesChanged > 0) !== (right.filesChanged > 0)) {
      return left.filesChanged > 0 ? -1 : 1;
    }
    if (left.filesChanged !== right.filesChanged) return right.filesChanged - left.filesChanged;
    return left.path.localeCompare(right.path);
  });

  // No sources: there is nothing to diff at this level. The panel lists
  // `workspaceRepositories` and re-asks with a child's path when one is opened.
  return { isRepo: true, sources: [], workspaceRepositories: ordered };
}

/**
 * `git init` — the one write this module allows.
 *
 * Everything else here is read-only because the agent is the thing that
 * writes, but "Initialize Git" is a different kind of action: it creates a
 * repository in a folder the user picked, touches nothing that already exists,
 * and there is no agent involved to do it for them. Refusing it left the
 * button in the UI failing with `vcs.init is not supported`.
 *
 * Errors are RAISED rather than swallowed into a null like the readers above:
 * a status that cannot be read is fairly reported as "not a repo", but an init
 * that silently did nothing would leave the button looking broken again.
 */
export async function init(cwd: string): Promise<void> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  // Already a repo — including a parent being one, which is what `git init` in
  // a subdirectory would silently turn into a confusing nested repository.
  if (inside?.trim() === "true") return;
  try {
    await run("git", ["init"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch (error) {
    // git writes the useful part to stderr ("permission denied", "not a
    // directory"); the exec error's own message is just the exit code.
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git init failed in ${cwd}`);
  }
}
