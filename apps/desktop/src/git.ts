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
import { devNull } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Bounded so a pathological repo cannot wedge the main process. */
const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

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
    const { stdout } = await run("git", [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      // A pager would never return; git turns it off when not a TTY, but an
      // explicit -c is the only guarantee across user configs.
      env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch {
    // A non-zero exit is an answer, not a crash: "not a repo", "no upstream",
    // "no such ref" all arrive this way and each has a sensible empty result.
    return null;
  }
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

export async function status(cwd: string): Promise<GitStatus> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return EMPTY_STATUS;

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
    ({ stdout } = await run("git", [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
    }));
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

export interface GitDiffPreview {
  readonly isRepo: boolean;
  readonly sources: readonly GitDiffPreviewSource[];
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
export async function diffPreview(
  cwd: string,
  options: { readonly baseRef?: string; readonly ignoreWhitespace?: boolean } = {},
): Promise<GitDiffPreview> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return { isRepo: false, sources: [] };

  const whitespace = options.ignoreWhitespace ? ["--ignore-all-space"] : [];
  const branch = (await git(cwd, ["branch", "--show-current"]))?.trim() || null;
  const baseRef = options.baseRef?.trim() || (await baseBranchFor(cwd, branch));

  const [tracked, untracked, range] = await Promise.all([
    patch(cwd, ["diff", ...PATCH_FLAGS, ...whitespace, "HEAD", "--"], MAX_TRACKED_DIFF_BYTES),
    untrackedPatch(cwd),
    baseRef
      ? patch(
          cwd,
          ["diff", ...PATCH_FLAGS, ...whitespace, `${baseRef}...HEAD`],
          MAX_TRACKED_DIFF_BYTES,
        )
      : Promise.resolve({ diff: "", truncated: false }),
  ]);

  const workingTree = [tracked.diff.trimEnd(), untracked.diff.trimEnd()]
    .filter((diff) => diff !== "")
    .join("\n");

  return {
    isRepo: true,
    sources: [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Working tree",
        baseRef: "HEAD",
        headRef: null,
        diff: workingTree,
        diffHash: sha256(workingTree),
        truncated: tracked.truncated || untracked.truncated,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: baseRef ? `Against ${baseRef}` : "Against base branch",
        baseRef,
        headRef: branch ?? "HEAD",
        diff: range.diff,
        diffHash: sha256(range.diff),
        truncated: range.truncated,
      },
    ],
  };
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
