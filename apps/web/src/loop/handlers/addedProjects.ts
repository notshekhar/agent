/**
 * Folders that have been added but not yet used.
 *
 * loop has no project record — a folder IS a project because a session has
 * that cwd (see shell.ts). That leaves "Add project" with nothing to write,
 * and a folder the user just added would not appear anywhere until they sent
 * a first message. The palette drops them straight into a composer for it, so
 * the app would be asking them to start in a project it claims not to have.
 *
 * So an added folder is held here and reported as a project until a session
 * makes it real. The entry then stops being emitted — the session-derived
 * project takes over, under the folder as its id, and there is never a moment
 * with two rows for one folder.
 *
 * Deliberately NOT persisted. Nothing can remove a project in loop's model
 * except its last session going away, so a folder that was added, never used,
 * and remembered forever would be a row the user cannot get rid of. Adding a
 * folder and using it is one continuous action; adding one and quitting first
 * leaves no litter.
 */

export interface AddedProject {
  /** The id the palette minted, which the draft it opened is pointed at. */
  readonly id: string;
  readonly folder: string;
  readonly addedAt: number;
}

const added = new Map<string, AddedProject>();
const listeners = new Set<() => void>();

export function rememberAddedProject(id: string, folder: string): void {
  added.set(id, { id, folder, addedAt: Date.now() });
  for (const listener of listeners) listener();
}

/**
 * The added folders that no session has claimed yet.
 *
 * Claimed ones are dropped as they are found, so this stays small and the
 * hand-off happens exactly once.
 */
export function listUnclaimedProjects(claimedFolders: ReadonlySet<string>): readonly AddedProject[] {
  const unclaimed: AddedProject[] = [];
  for (const project of added.values()) {
    if (claimedFolders.has(project.folder)) added.delete(project.id);
    else unclaimed.push(project);
  }
  return unclaimed;
}

/** Forget an added folder — the removal path for one no session ever claimed. */
export function forgetAddedProject(id: string): void {
  if (added.delete(id)) {
    for (const listener of listeners) listener();
  }
}

/** Notified whenever a folder is added. Returns an unsubscribe. */
export function onAddedProjectsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
