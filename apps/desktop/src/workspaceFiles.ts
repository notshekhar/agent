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
import { homedir } from "node:os";
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

/**
 * Paths that repeat the tail of the root, resolved the way a person reads them.
 *
 * An agent working in `~/code/app/stories` habitually writes `stories/x.md` —
 * the path from the repository, not from its own cwd — and naive resolution
 * turns that into `~/code/app/stories/stories/x.md`, which does not exist. So
 * clicking the file in the chat opened a pane that could not load it.
 *
 * Longest overlap first, and only as a FALLBACK after the literal path misses:
 * a real `stories/stories/x.md` still wins, because it is tried first and
 * found. Everything returned still has to pass the containment check.
 */
function overlapCandidates(root: string, relativePath: string): string[] {
  const rootParts = root.split(sep).filter((part) => part !== "");
  const pathParts = relativePath.replaceAll("\\", "/").split("/").filter((part) => part !== "");
  const candidates: string[] = [];
  const maxOverlap = Math.min(rootParts.length, pathParts.length - 1);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const tail = rootParts.slice(rootParts.length - overlap);
    const head = pathParts.slice(0, overlap);
    if (tail.every((part, index) => part.toLowerCase() === head[index]?.toLowerCase())) {
      candidates.push(resolve(root, pathParts.slice(overlap).join("/")));
    }
  }
  return candidates;
}

export async function readWorkspaceFile(
  cwd: string,
  relativePath: string,
): Promise<ReadWorkspaceFileResult> {
  const root = resolve(cwd);
  const literal = resolve(root, relativePath);
  if (!isInside(root, literal)) return { ok: false, failure: "resolved_path_outside_root" };

  let absolute: string | undefined;
  let info;
  for (const candidate of [literal, ...overlapCandidates(root, relativePath)]) {
    if (!isInside(root, candidate)) continue;
    try {
      const candidateInfo = await stat(candidate);
      if (!candidateInfo.isFile()) continue;
      absolute = candidate;
      info = candidateInfo;
      break;
    } catch {
      // Missing, so try the next reading of the path.
    }
  }
  if (!absolute || !info) {
    // Reported against the literal path: it is what the user clicked, and
    // naming a guessed one in the error would be more confusing, not less.
    try {
      return (await stat(literal)).isFile()
        ? { ok: false, failure: "path_not_found" }
        : { ok: false, failure: "path_not_file" };
    } catch {
      return { ok: false, failure: "path_not_found" };
    }
  }

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

/** Image previews. Big enough for a screenshot, small enough to not stall IPC. */
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

const ASSET_MIME_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export type ReadAssetResult =
  | { readonly ok: true; readonly data: Uint8Array; readonly mimeType: string }
  | { readonly ok: false; readonly failure: string };

/**
 * A file's raw bytes, for the panes that show something other than text.
 *
 * `readWorkspaceFile` refuses anything with a NUL byte — correct for a text
 * pane, and exactly why the image preview had nothing to show. This is the
 * binary counterpart: no decoding, no truncation to a text window, and a
 * declared MIME type so the renderer can wrap it in a blob URL the `<img>`
 * will accept.
 *
 * Absolute paths only. Unlike the text reader there is no project root to
 * check against — the caller already has the path from a listing of the
 * project it opened.
 */
export async function readWorkspaceAsset(absolutePath: string): Promise<ReadAssetResult> {
  const target = resolve(expandHome(absolutePath));
  let info;
  try {
    info = await stat(target);
  } catch {
    return { ok: false, failure: "path_not_found" };
  }
  if (!info.isFile()) return { ok: false, failure: "path_not_file" };
  if (info.size > MAX_ASSET_BYTES) return { ok: false, failure: "file_too_large" };

  const extension = target.slice(target.lastIndexOf(".")).toLowerCase();
  const buffer = await readFile(target);
  return {
    ok: true,
    // A Buffer is a Uint8Array, but Electron's structured clone sends it as one
    // only if it is not also carrying Buffer's prototype across the boundary.
    data: new Uint8Array(buffer),
    mimeType: ASSET_MIME_TYPES[extension] ?? "application/octet-stream",
  };
}

/**
 * `~` is a shell convention, not a filesystem one — node would resolve
 * "~/documents" to "<cwd>/~/documents", a folder nobody has. The picker's own
 * placeholder offers "~/projects/foo", so it has to mean what it looks like.
 */
export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith(`~${sep}`)) {
    return join(homedir(), input.slice(2));
  }
  return input;
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
  const requested = expandHome(partialPath);
  const base = isAbsolute(requested) ? requested : resolve(cwd ?? process.cwd(), requested);
  // A trailing separator means "inside this directory"; otherwise the last
  // segment is a partial name and the parent is what to list. Tested on the
  // ORIGINAL string: join() drops the trailing separator while expanding.
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
