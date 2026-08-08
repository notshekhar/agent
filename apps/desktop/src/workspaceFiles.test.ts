import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkspaceFile } from "./workspaceFiles";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "loop-workspace-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("readWorkspaceFile", () => {
  test("reads a path relative to the cwd", async () => {
    const root = await workspace();
    await writeFile(join(root, "note.md"), "hello");

    const result = await readWorkspaceFile(root, "note.md");
    expect(result).toMatchObject({ ok: true, contents: "hello", relativePath: "note.md" });
  });

  test("resolves a path that repeats the cwd's own last segment", async () => {
    // The case from the chat: the agent runs in `<repo>/stories` and writes
    // `stories/monday-shirt.md`, meaning the path from the repository root.
    const repo = await workspace();
    const stories = join(repo, "stories");
    await mkdir(stories);
    await writeFile(join(stories, "monday-shirt.md"), "Monday's Shirt");

    const result = await readWorkspaceFile(stories, "stories/monday-shirt.md");
    expect(result).toMatchObject({
      ok: true,
      contents: "Monday's Shirt",
      relativePath: "monday-shirt.md",
    });
  });

  test("prefers a literal match over the overlap reading", async () => {
    const repo = await workspace();
    const stories = join(repo, "stories");
    await mkdir(join(stories, "stories"), { recursive: true });
    await writeFile(join(stories, "monday-shirt.md"), "collapsed");
    await writeFile(join(stories, "stories", "monday-shirt.md"), "literal");

    const result = await readWorkspaceFile(stories, "stories/monday-shirt.md");
    expect(result).toMatchObject({ ok: true, contents: "literal" });
  });

  test("still reports a path that exists under neither reading", async () => {
    const root = await workspace();
    const result = await readWorkspaceFile(root, "nope/missing.md");
    expect(result).toEqual({ ok: false, failure: "path_not_found" });
  });

  test("refuses to escape the root", async () => {
    const root = await workspace();
    const result = await readWorkspaceFile(root, "../../etc/passwd");
    expect(result).toEqual({ ok: false, failure: "resolved_path_outside_root" });
  });
});
