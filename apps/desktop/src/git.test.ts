import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { diffPreview, status, workspaceRepositories } from "./git";

const run = promisify(execFile);

/** A repo with one commit on `main`, one edit, and one untracked file. */
let repo: string;

async function git(...args: string[]): Promise<void> {
  await run("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "loop",
      GIT_AUTHOR_EMAIL: "loop@example.com",
      GIT_COMMITTER_NAME: "loop",
      GIT_COMMITTER_EMAIL: "loop@example.com",
    },
  });
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "loop-git-"));
  await git("init", "--initial-branch=main");
  await writeFile(join(repo, "tracked.txt"), "one\n");
  await git("add", ".");
  await git("commit", "-m", "first");

  await git("checkout", "-b", "feature");
  await writeFile(join(repo, "tracked.txt"), "one\ntwo\n");
  await git("commit", "-am", "second");

  await writeFile(join(repo, "tracked.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "untracked.txt"), "fresh\n");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("diffPreview", () => {
  test("reports a folder that is not a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "loop-plain-"));
    try {
      expect(await diffPreview(plain)).toEqual({ isRepo: false, sources: [] });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  test("returns both sources with stable hashes", async () => {
    const preview = await diffPreview(repo);
    expect(preview.isRepo).toBe(true);
    expect(preview.sources.map((source) => source.kind)).toEqual([
      "working-tree",
      "branch-range",
    ]);
    for (const source of preview.sources) {
      expect(source.diffHash).toMatch(/^[0-9a-f]{64}$/);
      expect(source.truncated).toBe(false);
    }
  });

  test("the working tree covers uncommitted edits and untracked files", async () => {
    const [workingTree] = (await diffPreview(repo)).sources;
    expect(workingTree?.baseRef).toBe("HEAD");
    // The edit that was never committed, not the one that was.
    expect(workingTree?.diff).toContain("+three");
    expect(workingTree?.diff).not.toContain("+two");
    // Untracked files are absent from `git diff`, so they are diffed apart.
    expect(workingTree?.diff).toContain("untracked.txt");
    expect(workingTree?.diff).toContain("+fresh");
  });

  test("the branch range is measured against the base branch", async () => {
    const [, range] = (await diffPreview(repo)).sources;
    expect(range?.baseRef).toBe("main");
    expect(range?.headRef).toBe("feature");
    // `main...HEAD` is what the branch added, so the committed line is in and
    // the uncommitted one is not.
    expect(range?.diff).toContain("+two");
    expect(range?.diff).not.toContain("+three");
  });

  test("an explicit base ref wins over the guess", async () => {
    const [, range] = (await diffPreview(repo, { baseRef: "feature" })).sources;
    expect(range?.baseRef).toBe("feature");
    expect(range?.diff).toBe("");
  });
});

/** A folder that is not a repository but holds two, one of them nested. */
describe("a folder of repositories", () => {
  let workspace: string;

  const commit = (cwd: string, ...args: string[]) =>
    run("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "loop",
        GIT_AUTHOR_EMAIL: "loop@example.com",
        GIT_COMMITTER_NAME: "loop",
        GIT_COMMITTER_EMAIL: "loop@example.com",
      },
    });

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "loop-workspace-"));
    for (const relative of ["payments", join("group", "billing")]) {
      const service = join(workspace, relative);
      await mkdir(join(service, "src"), { recursive: true });
      await commit(service, "init", "--initial-branch=main");
      await writeFile(join(service, "src", "index.ts"), "one\n");
      await commit(service, "add", ".");
      await commit(service, "commit", "-m", "first");
      await writeFile(join(service, "src", "index.ts"), "one\ntwo\n");
      await writeFile(join(service, "src", "new.ts"), "fresh\n");
    }
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("finds repositories one and two levels down, and skips the rest", async () => {
    expect(await workspaceRepositories(workspace)).toEqual(["group/billing", "payments"]);
  });

  test("reports itself as a repository so the diff panel opens", async () => {
    const workspaceStatus = await status(workspace);
    expect(workspaceStatus.isRepo).toBe(true);
    expect(workspaceStatus.refName).toBe("main");
    expect(workspaceStatus.workingTree.files.map((file) => file.path)).toContain(
      "payments/src/index.ts",
    );
    // Nothing to push from a folder that is not itself a repository.
    expect(workspaceStatus.hasPrimaryRemote).toBe(false);
    expect(workspaceStatus.hasUpstream).toBe(false);
  });

  test("lists the repositories instead of one giant patch", async () => {
    const preview = await diffPreview(workspace);
    expect(preview.isRepo).toBe(true);
    // Nothing to diff at this level; the panel opens one repository at a time.
    expect(preview.sources).toEqual([]);
    expect(preview.workspaceRepositories?.map((repo) => repo.path)).toEqual([
      "group/billing",
      "payments",
    ]);
    const [first] = preview.workspaceRepositories ?? [];
    expect(first?.branch).toBe("main");
    // One edited file and one untracked, in each service.
    expect(first?.filesChanged).toBe(2);
    expect(first?.insertions).toBe(1);
  });

  test("sorts repositories with changes above quiet ones", async () => {
    const quiet = join(workspace, "quiet");
    await mkdir(quiet, { recursive: true });
    await commit(quiet, "init", "--initial-branch=main");
    await writeFile(join(quiet, "only.txt"), "committed\n");
    await commit(quiet, "add", ".");
    await commit(quiet, "commit", "-m", "first");
    try {
      const preview = await diffPreview(workspace);
      const paths = preview.workspaceRepositories?.map((repo) => repo.path) ?? [];
      // Both changed services come first; the clean one sinks to the bottom.
      expect(paths.at(-1)).toBe("quiet");
      expect(preview.workspaceRepositories?.at(-1)?.filesChanged).toBe(0);
    } finally {
      await rm(quiet, { recursive: true, force: true });
    }
  });

  test("a repository inside the folder still diffs normally", async () => {
    const preview = await diffPreview(join(workspace, "payments"));
    expect(preview.isRepo).toBe(true);
    expect(preview.workspaceRepositories).toBeUndefined();
    const [workingTree] = preview.sources;
    // Unprefixed: the panel asked for this repository, so paths are its own.
    expect(workingTree?.diff).toContain("b/src/index.ts");
    expect(workingTree?.diff).toContain("--- /dev/null");
  });

  test("a folder with neither a repository nor children is still not a repo", async () => {
    const empty = await mkdtemp(join(tmpdir(), "loop-empty-"));
    try {
      expect(await diffPreview(empty)).toEqual({ isRepo: false, sources: [] });
      expect((await status(empty)).isRepo).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
