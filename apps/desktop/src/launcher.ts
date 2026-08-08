/**
 * Opening things outside the app: editors and the file manager.
 *
 * The renderer owns the editor table (it lives in the contracts, and the UI
 * draws its labels), so this side stays deliberately generic: it answers "which
 * of these commands exist on PATH" and "run this one". Duplicating the table
 * here would mean two lists to keep in step, and the one in the shell would be
 * the one nobody remembered to update.
 *
 * Without this, `shell.openInEditor` failed as unsupported and the server
 * config reported no editors at all, so the "Open in..." menu was permanently
 * empty — there was nothing to detect them with.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const WHICH_TIMEOUT_MS = 5_000;

/**
 * Which of `commands` are runnable, mapped to their resolved paths.
 *
 * Uses `which`/`where` rather than walking PATH by hand so shims, aliases in
 * `/usr/local/bin`, and Windows' `.cmd` wrappers all resolve the way the
 * shell would actually run them.
 */
export async function whichCommands(
  commands: readonly string[],
): Promise<Record<string, string | null>> {
  const finder = process.platform === "win32" ? "where" : "which";
  const entries = await Promise.all(
    [...new Set(commands)].map(async (command) => {
      try {
        const { stdout } = await run(finder, [command], { timeout: WHICH_TIMEOUT_MS });
        const first = stdout.split("\n").map((line) => line.trim()).find((line) => line !== "");
        return [command, first ?? null] as const;
      } catch {
        // Not installed. A normal answer, not a failure.
        return [command, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Launch a detached process and stop caring about it.
 *
 * Detached with its stdio ignored, and `unref`'d: an editor is a long-lived
 * GUI app, and leaving it as a tracked child would keep pipes open and tie its
 * lifetime to the app the user is about to switch away from.
 */
export function launch(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
      // `code`, `cursor` and friends are .cmd shims on Windows, which
      // CreateProcess cannot run without a shell.
      shell: process.platform === "win32",
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`${command} is not installed or not on PATH`)
          : error,
      );
    });
    child.on("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

/** The OS file manager, for the "Reveal in Finder" style option. */
export function revealCommand(): { command: string; args: readonly string[] } {
  if (process.platform === "darwin") return { command: "open", args: [] };
  if (process.platform === "win32") return { command: "explorer", args: [] };
  return { command: "xdg-open", args: [] };
}
