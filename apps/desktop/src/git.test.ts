import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { diffPreview } from "./git";

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
