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
import { promisify } from "node:util";

const run = promisify(execFile);

/** Bounded so a pathological repo cannot wedge the main process. */
const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

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
