import { loopFilesystem, loopGit } from "../../loop/transport";
import { type LineChange, applyLineChanges, invertLineChange } from "./applyLineChanges";

/**
 * Stage or unstage part of a file.
 *
 * Both directions are the same operation between different pairs of versions,
 * which is why they share an implementation rather than being written twice and
 * kept in step:
 *
 *   staging   index → working tree   (apply the selected change to the index)
 *   unstaging HEAD  → index          (apply it backwards, so the index loses it)
 *
 * The result is written straight into the index as content, so the working tree
 * is never touched — staging a hunk must leave the rest of your edits exactly
 * where they are, which is the entire point of doing it.
 */
export async function applyPartialStage(input: {
  readonly cwd: string;
  readonly path: string;
  readonly direction: "stage" | "unstage";
  readonly changes: readonly LineChange[];
}): Promise<void> {
  const git = loopGit();
  if (!git?.stageContent || !git.fileAtRevision) {
    throw new Error("This build of loop cannot stage part of a file.");
  }
  if (input.changes.length === 0) return;

  // Missing at a revision means the file does not exist there yet — a new file
  // has no HEAD version and an untracked one has no index version. Empty is the
  // correct "before" in both cases.
  const index = (await git.fileAtRevision(input.cwd, "index", input.path)) ?? "";

  if (input.direction === "unstage") {
    const head = (await git.fileAtRevision(input.cwd, "HEAD", input.path)) ?? "";
    // Backwards: the index is the thing being edited, and HEAD supplies the
    // lines that replace what is being taken out of it.
    const reverted = applyLineChanges(index, head, input.changes.map(invertLineChange));
    await git.stageContent(input.cwd, input.path, reverted);
    return;
  }

  const fs = loopFilesystem();
  if (!fs) throw new Error("No filesystem available to read the working copy.");
  const working = await fs.read(input.cwd, input.path);
  if (!working.ok) throw new Error(`Could not read ${input.path}: ${working.failure}`);
  if (working.truncated) {
    // Staging from a truncated read would write a shortened file into the index.
    throw new Error(`${input.path} is too large to stage in parts.`);
  }

  await git.stageContent(
    input.cwd,
    input.path,
    applyLineChanges(index, working.contents, input.changes),
  );
}
