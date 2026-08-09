import type { FileTreeDirectoryHandle } from "@pierre/trees";
import { FileTree } from "@pierre/trees";
import { describe, expect, it } from "vite-plus/test";

/**
 * The file browser drives the tree's search from its own input (`search: false`),
 * so a filtered tree has to survive being clicked on. Upstream ties both halves
 * of that to the tree's built-in search UI, and `patches/@pierre%2Ftrees` undoes
 * it: a row click no longer closes a search the consumer owns, and expanding or
 * collapsing a folder no longer re-runs the search's own expansion pass — which
 * used to snap a just-collapsed folder straight back open.
 *
 * The tree renders into shadow DOM, so the click itself is out of reach here;
 * these drive the model the way a row click drives it.
 */

const PATHS = [
  "src/",
  "src/components/",
  "src/components/Button.tsx",
  "src/components/ButtonGroup.tsx",
  "src/components/Modal.tsx",
  "src/utils/",
  "src/utils/button-helpers.ts",
  "src/utils/misc.ts",
  "README.md",
];

function createTree() {
  return new FileTree({
    paths: PATHS,
    fileTreeSearchMode: "hide-non-matches",
    initialExpansion: 1,
    search: false,
  });
}

// `isDirectory()` returns a literal rather than narrowing the union, so the
// handle is asserted here instead.
function directory(tree: FileTree, path: string): FileTreeDirectoryHandle {
  const item = tree.getItem(path);
  if (item == null || !item.isDirectory()) {
    throw new Error(`expected a directory at ${path}`);
  }
  return item as FileTreeDirectoryHandle;
}

describe("file tree search", () => {
  it("keeps the filter when a matching folder is collapsed", () => {
    const tree = createTree();
    tree.setSearch("button");
    expect(directory(tree, "src/components/").isExpanded()).toBe(true);

    directory(tree, "src/components/").collapse();

    expect(directory(tree, "src/components/").isExpanded()).toBe(false);
    expect(tree.isSearchOpen()).toBe(true);
    expect(tree.getSearchValue()).toBe("button");
    // A sibling the search opened stays open, so the filter is still applied.
    expect(directory(tree, "src/utils/").isExpanded()).toBe(true);
  });

  it("re-expands a folder without leaking non-matching files", () => {
    const tree = createTree();
    tree.setSearch("button");
    directory(tree, "src/components/").collapse();

    directory(tree, "src/components/").expand();

    expect(tree.getSearchMatchingPaths()).toEqual([
      "src/components/Button.tsx",
      "src/components/ButtonGroup.tsx",
      "src/utils/button-helpers.ts",
    ]);
  });

  it("recomputes expansion for a new query", () => {
    const tree = createTree();
    tree.setSearch("button");
    directory(tree, "src/components/").collapse();

    tree.setSearch("modal");

    expect(directory(tree, "src/components/").isExpanded()).toBe(true);
    expect(tree.getSearchMatchingPaths()).toEqual(["src/components/Modal.tsx"]);
  });

  it("restores the pre-search expansion when the search closes", () => {
    const tree = createTree();
    tree.setSearch("button");
    directory(tree, "src/components/").collapse();

    tree.closeSearch();

    expect(tree.isSearchOpen()).toBe(false);
    expect(directory(tree, "src/components/").isExpanded()).toBe(false);
    expect(directory(tree, "src/utils/").isExpanded()).toBe(false);
  });
});
