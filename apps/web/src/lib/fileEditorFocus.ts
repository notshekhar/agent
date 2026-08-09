/**
 * Whether the caret is in an editable file pane.
 *
 * The same question `terminalFocus` answers for the terminal, and it exists for
 * the same reason: `mod+s` is bound to `composer.stash`, and the composer
 * claims it on `window` in the capture phase — which runs before anything
 * listening on `document`. So an editor that merely listened for its own save
 * shortcut would never be reached, and `⌘S` over a file would stash a chat
 * draft instead of writing the file.
 *
 * Asked of the DOM rather than tracked in a store, because focus already lives
 * there and a second copy would be one more thing to keep in sync. The editor
 * renders into a shadow root, so `document.activeElement` alone only ever
 * reports the host element; `data-content` is the attribute the editor puts on
 * the element that actually takes the caret.
 */
export function isFileEditorFocused(): boolean {
  for (const container of document.querySelectorAll("diffs-container")) {
    const active = (container as HTMLElement).shadowRoot?.activeElement;
    if (active?.hasAttribute("data-content")) return true;
  }
  return false;
}
