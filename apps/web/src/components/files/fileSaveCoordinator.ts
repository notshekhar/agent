import type { AtomCommandResult } from "@loop/runtime/state/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
}

/**
 * Holds an edited file until someone asks for it to be written.
 *
 * Saving is explicit. Typing marks the file dirty and nothing else; the write
 * happens when the editor's save shortcut fires. The alternative — a debounce
 * timer that wrote half a second after you stopped typing — meant every
 * keystroke was a commitment, with no moment where a half-finished edit was
 * only yours. An editor should not decide that for you.
 *
 * The edited text is not lost by declining to write it: the panel keeps it in
 * the optimistic file cache, so switching tabs and coming back shows the edit,
 * still marked unsaved.
 *
 * Writes are serialised. A save requested while one is in flight does not race
 * it — it runs afterwards, and only if the text moved on, so the newest
 * contents always win and an unchanged file is never rewritten.
 */
export class FileSaveCoordinator<A = unknown, E = unknown> {
  private latestContents = "";
  private latestRevision = 0;
  private savedRevision = 0;
  private saving = false;
  private saveAgain = false;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  /** True when the buffer holds edits that have not been written. */
  get pending(): boolean {
    return this.latestRevision !== this.savedRevision;
  }

  change(contents: string): void {
    this.latestContents = contents;
    this.latestRevision += 1;
    this.options.onPendingChange(true);
  }

  /**
   * Write the current contents.
   *
   * Resolves once nothing is left to write, or once a write has failed — the
   * caller uses that to decide whether to report the failure. A file with no
   * unsaved edits resolves immediately without touching the disk, so hitting
   * the shortcut twice is not two writes.
   */
  async save(): Promise<boolean> {
    if (this.saving) {
      // Fold into the running save rather than starting a second one.
      this.saveAgain = true;
      return true;
    }
    this.saving = true;
    try {
      let ok = true;
      do {
        this.saveAgain = false;
        if (!this.pending) break;
        const contents = this.latestContents;
        const revision = this.latestRevision;
        const result = await this.options.persist(contents);
        if (result._tag !== "Success") {
          // Stay dirty: the mark is the only thing telling the user the file
          // on disk is not what is on screen.
          ok = false;
          break;
        }
        this.savedRevision = revision;
        this.options.onConfirmed(contents);
        // Only when nothing arrived while the write was in flight; otherwise
        // the loop goes round again and clears it then.
        if (revision === this.latestRevision) this.options.onPendingChange(false);
      } while (this.saveAgain || this.pending);
      return ok;
    } finally {
      this.saving = false;
    }
  }

  /**
   * Nothing is written here.
   *
   * A pane closing is not a decision to save — that was the old debounce's
   * habit, and it is the same surprise by a different route. The unsaved text
   * survives in the optimistic cache and the file stays marked dirty.
   */
  dispose(): void {}
}
