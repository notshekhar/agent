/**
 * Keystroke-level rules for the address bar, kept out of the component so the
 * fiddly parts (when to type-ahead, where the highlight goes) are testable.
 */
import {
  previewUrlInlineCompletion,
  type PreviewUrlSuggestion,
} from "./previewUrlHistory";

export interface OmniboxInputState {
  /** What the input shows: the typed text plus any completed remainder. */
  readonly value: string;
  /** What the user actually typed — suggestions always filter on this. */
  readonly typed: string;
  /** Range of `value` to select, so the next keystroke replaces the guess. */
  readonly selection: { readonly start: number; readonly end: number } | null;
}

/** Highlighting nothing: the input owns the value, not a suggestion row. */
export const NO_OMNIBOX_HIGHLIGHT = -1;

export function resolveOmniboxInput(input: {
  readonly value: string;
  readonly inputType: string | undefined;
  readonly caretAtEnd: boolean;
  readonly suggestions: ReadonlyArray<PreviewUrlSuggestion>;
}): OmniboxInputState {
  const plain: OmniboxInputState = { value: input.value, typed: input.value, selection: null };
  // Completing while the user backspaces would fight them for the text, and
  // completing mid-string would put the guess somewhere they can't see.
  if (input.inputType?.startsWith("delete") === true || !input.caretAtEnd) return plain;

  const completion = previewUrlInlineCompletion(input.value, input.suggestions);
  if (!completion) return plain;
  return {
    value: completion.value,
    typed: input.value,
    selection: { start: input.value.length, end: completion.value.length },
  };
}

/**
 * Arrow-key movement through the suggestion list. Walking off either end
 * returns to the input, the way a browser hands you back what you typed.
 */
export function nextOmniboxHighlight(current: number, direction: 1 | -1, count: number): number {
  if (count <= 0) return NO_OMNIBOX_HIGHLIGHT;
  if (current === NO_OMNIBOX_HIGHLIGHT) return direction === 1 ? 0 : count - 1;
  const next = current + direction;
  return next < 0 || next >= count ? NO_OMNIBOX_HIGHLIGHT : next;
}
