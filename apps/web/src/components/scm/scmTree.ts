import type { ScmRow } from "./scmGroups";

/**
 * The tree shape of a group's rows, with single-child directories collapsed.
 *
 * A flat list of eighteen files under `apps/web/src/components/...` is mostly
 * repeated path — the same prefix redrawn on every row, pushing the filenames
 * that actually distinguish them out of view. VS Code's answer is a tree whose
 * chains of single-child directories are folded into one node, so the shared
 * prefix is stated once and the names get the width.
 *
 * Pure, so the folding is assertable without rendering anything.
 */

export interface ScmTreeFile {
  readonly kind: "file";
  readonly row: ScmRow;
  /** The part of the path this node contributes — usually the file name. */
  readonly label: string;
}

export interface ScmTreeDirectory {
  readonly kind: "directory";
  /** Possibly several segments, when a chain was folded: `src/components`. */
  readonly label: string;
  /** Full path from the repository root, so expansion state has a stable key. */
  readonly path: string;
  readonly children: readonly ScmTreeNode[];
  /** Files anywhere beneath, for the count on the row. */
  readonly fileCount: number;
}

export type ScmTreeNode = ScmTreeFile | ScmTreeDirectory;

interface Building {
  readonly directories: Map<string, Building>;
  readonly files: ScmRow[];
}

const empty = (): Building => ({ directories: new Map(), files: [] });

/**
 * Build the folded tree for one group's rows.
 *
 * Rows are already sorted by path, and insertion order is preserved, so the
 * result needs no second sort — directories appear where their first file put
 * them, which keeps the list stable between polls.
 */
export function buildTree(rows: readonly ScmRow[]): readonly ScmTreeNode[] {
  const root = empty();

  for (const row of rows) {
    const segments = row.change.path.split("/").filter((segment) => segment !== "");
    const fileName = segments.pop();
    if (fileName === undefined) continue;
    let node = root;
    for (const segment of segments) {
      let next = node.directories.get(segment);
      if (!next) {
        next = empty();
        node.directories.set(segment, next);
      }
      node = next;
    }
    node.files.push(row);
  }

  return toNodes(root, "");
}

function toNodes(node: Building, prefix: string): ScmTreeNode[] {
  const out: ScmTreeNode[] = [];

  for (const [name, child] of node.directories) {
    // Fold a chain of directories that each hold exactly one directory and no
    // files: `a/` → `b/` → `c/x.ts` becomes one `a/b/c` node.
    let label = name;
    let current = child;
    let path = prefix === "" ? name : `${prefix}/${name}`;
    while (current.files.length === 0 && current.directories.size === 1) {
      const [onlyName, onlyChild] = [...current.directories.entries()][0]!;
      label = `${label}/${onlyName}`;
      path = `${path}/${onlyName}`;
      current = onlyChild;
    }
    const children = toNodes(current, path);
    out.push({
      kind: "directory",
      label,
      path,
      children,
      fileCount: countFiles(children),
    });
  }

  for (const row of node.files) {
    const path = row.change.path;
    out.push({ kind: "file", row, label: path.slice(path.lastIndexOf("/") + 1) });
  }

  return out;
}

function countFiles(nodes: readonly ScmTreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += node.kind === "file" ? 1 : node.fileCount;
  }
  return total;
}
