/**
 * Reading the workspace, for the file picker and @-mentions.
 *
 * loop's RPC has no file operations — it is an agent protocol, not a file
 * server — so these are answered by the shell, which is the only side with a
 * filesystem. In a browser they stay unavailable and fail loudly rather than
 * returning something plausible and empty.
 *
 * Every path that comes back in is re-resolved and checked against the root
 * before it is touched. The renderer is not hostile, but it is the surface an
 * agent's output reaches, and a `../../..` in a filename should be a rejection
 * rather than a read.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Directories never worth walking; they dwarf the real tree. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "zig-cache",
  "zig-out",
]);

/** Bounds, so one enormous repo cannot hang the picker or the main process. */
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_BROWSE_ENTRIES = 500;

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

/** True when `candidate` is inside `root` — the check every path must pass. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export async function listWorkspaceEntries(
  cwd: string,
): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  const root = resolve(cwd);
  const entries: WorkspaceEntry[] = [];
  let truncated = false;

  // Breadth-first, so a bounded result is the shallow part of the tree — the
  // part a person is most likely to be looking for.
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (next.depth > MAX_DEPTH) continue;

    let children;
    try {
      children = await readdir(next.directory, { withFileTypes: true });
    } catch {
      // An unreadable directory is skipped, not fatal: one permission error
      // deep in a tree must not empty the whole picker.
      continue;
    }

    for (const child of children) {
      if (child.name.startsWith(".") && child.name !== ".github") continue;
      const absolute = join(next.directory, child.name);
      if (!isInside(root, absolute)) continue;

      if (child.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(child.name)) continue;
        entries.push({ path: relative(root, absolute), kind: "directory" });
        queue.push({ directory: absolute, depth: next.depth + 1 });
      } else if (child.isFile()) {
        entries.push({ path: relative(root, absolute), kind: "file" });
      }

      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return { entries, truncated };
      }
    }
  }

  return { entries, truncated };
}

export type ReadWorkspaceFileResult =
  | {
      readonly ok: true;
      readonly relativePath: string;
      readonly contents: string;
      readonly byteLength: number;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly failure: string };

export async function readWorkspaceFile(
  cwd: string,
  relativePath: string,
): Promise<ReadWorkspaceFileResult> {
  const root = resolve(cwd);
  const absolute = resolve(root, relativePath);
  if (!isInside(root, absolute)) return { ok: false, failure: "resolved_path_outside_root" };

  let info;
  try {
    info = await stat(absolute);
  } catch {
    return { ok: false, failure: "path_not_found" };
  }
  if (!info.isFile()) return { ok: false, failure: "path_not_file" };

  const buffer = await readFile(absolute);
  const slice = buffer.subarray(0, MAX_FILE_BYTES);
  // A NUL byte in the first block is the cheap, reliable binary tell; sending
  // one to a text pane produces a wall of replacement characters.
  if (slice.subarray(0, 8_000).includes(0)) return { ok: false, failure: "binary_file" };

  return {
    ok: true,
    relativePath: relative(root, absolute),
    contents: slice.toString("utf8"),
    byteLength: buffer.byteLength,
    truncated: buffer.byteLength > slice.byteLength,
  };
}

/**
 * Directory listing for the path picker, which completes a partly-typed path.
 * Unlike the workspace walk this is free to leave the project, because it is
 * how a user chooses a folder that is not one yet.
 */
export async function browseFilesystem(
  partialPath: string,
  cwd: string | undefined,
): Promise<{ parentPath: string; entries: Array<{ name: string; fullPath: string }> } | null> {
  const base = isAbsolute(partialPath) ? partialPath : resolve(cwd ?? process.cwd(), partialPath);
  // A trailing separator means "inside this directory"; otherwise the last
  // segment is a partial name and the parent is what to list.
  const parent = partialPath.endsWith(sep) ? base : resolve(base, "..");

  let children;
  try {
    children = await readdir(parent, { withFileTypes: true });
  } catch {
    return null;
  }

  const entries = children
    .filter((child) => child.isDirectory() && !child.name.startsWith("."))
    .slice(0, MAX_BROWSE_ENTRIES)
    .map((child) => ({ name: child.name, fullPath: join(parent, child.name) }));

  return { parentPath: parent, entries };
}
