import type { ShortcutEventLike } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";

interface FileSaveShortcutOptions {
  root: HTMLElement;
  /** Defaults to the real one; a test supplies its own. */
  platform?: string;
  /** False while the pane is not the thing the keystroke was meant for. */
  isEnabled: () => boolean;
  onSave: () => void;
}

/**
 * Whether this keystroke is the platform's save.
 *
 * `⌘S` on macOS, `Ctrl+S` everywhere else — the same `mod` the keybindings
 * module resolves, so the editor agrees with the rest of the app about which
 * key means what. The opposite modifier is rejected rather than ignored:
 * `Ctrl+S` on a Mac is not a save, and treating it as one would swallow a
 * chord something else may want.
 *
 * Takes the same structural event shape `keybindings.ts` matches against, so
 * this is decidable without a DOM.
 */
export function isSaveShortcut(event: ShortcutEventLike, platform: string): boolean {
  if (event.key !== "s" && event.key !== "S") return false;
  if (event.altKey || event.shiftKey) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/**
 * `mod+S` saves the file being edited.
 *
 * Listens in the capture phase and stops the event dead, which is not
 * incidental: `mod+s` is already bound to `composer.stash`, and without this
 * the same keystroke would both save the file and stash the chat draft. The
 * editor is the more specific context, so it wins while the keystroke belongs
 * to it — the same arrangement, and the same mechanism, that lets the editor
 * take `Escape` without closing whatever else listens for it.
 */
export function installFileSaveShortcut({
  root,
  platform,
  isEnabled,
  onSave,
}: FileSaveShortcutOptions): () => void {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!isSaveShortcut(event, platform ?? navigator.platform)) return;
    if (!isEnabled() || !event.composedPath().includes(root)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onSave();
  };

  document.addEventListener("keydown", handleKeyDown, true);
  return () => document.removeEventListener("keydown", handleKeyDown, true);
}
