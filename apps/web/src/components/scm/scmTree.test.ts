import { describe, expect, it } from "vite-plus/test";

import type { ScmRow } from "./scmGroups";
import { type ScmTreeDirectory, buildTree } from "./scmTree";

const row = (path: string): ScmRow =>
  ({ change: { path }, group: "unstaged", letter: "M", insertions: 0, deletions: 0, key: path }) as ScmRow;

const dir = (node: unknown) => node as ScmTreeDirectory;

describe("building the tree", () => {
  it("folds a chain of single-child directories into one node", () => {
    // The whole point: `apps/web/src/components` is one row, not four.
    const tree = buildTree([row("apps/web/src/components/A.tsx")]);
    expect(tree).toHaveLength(1);
    expect(dir(tree[0]).kind).toBe("directory");
    expect(dir(tree[0]).label).toBe("apps/web/src/components");
    expect(dir(tree[0]).children[0]?.kind).toBe("file");
  });

  it("stops folding where the tree actually branches", () => {
    const tree = buildTree([row("apps/web/A.tsx"), row("apps/desktop/B.ts")]);
    expect(dir(tree[0]).label).toBe("apps");
    expect(dir(tree[0]).children.map((child) => dir(child).label)).toEqual(["web", "desktop"]);
  });

  it("stops folding at a directory that also holds files", () => {
    const tree = buildTree([row("src/index.ts"), row("src/lib/util.ts")]);
    expect(dir(tree[0]).label).toBe("src");
    const labels = dir(tree[0]).children.map((child) =>
      child.kind === "file" ? child.label : child.label,
    );
    expect(labels).toContain("lib");
    expect(labels).toContain("index.ts");
  });

  it("counts every file beneath a directory", () => {
    const tree = buildTree([row("a/b/one.ts"), row("a/b/two.ts"), row("a/c/three.ts")]);
    expect(dir(tree[0]).label).toBe("a");
    expect(dir(tree[0]).fileCount).toBe(3);
  });

  it("keeps files at the repository root at the top level", () => {
    const tree = buildTree([row("README.md")]);
    expect(tree[0]?.kind).toBe("file");
    expect(tree[0]?.kind === "file" && tree[0].label).toBe("README.md");
  });

  it("gives each directory a stable full path for expansion state", () => {
    const tree = buildTree([row("a/b/one.ts"), row("a/c/two.ts")]);
    const paths = dir(tree[0]).children.map((child) => dir(child).path);
    expect(paths).toEqual(["a/b", "a/c"]);
  });

  it("is empty for no rows", () => {
    expect(buildTree([])).toEqual([]);
  });
});
