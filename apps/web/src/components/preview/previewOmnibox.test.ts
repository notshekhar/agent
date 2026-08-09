import { describe, expect, it } from "vite-plus/test";

import {
  NO_OMNIBOX_HIGHLIGHT,
  nextOmniboxHighlight,
  resolveOmniboxInput,
} from "./previewOmnibox";
import { matchPreviewUrlSuggestions, type PreviewUrlHistoryEntry } from "./previewUrlHistory";

const HISTORY: ReadonlyArray<PreviewUrlHistoryEntry> = [
  { url: "http://localhost:3000/", title: "Home", visits: 4, lastVisitedAt: 200 },
  { url: "http://localhost:3000/settings", title: "Settings", visits: 1, lastVisitedAt: 100 },
];

const suggestionsFor = (query: string) => matchPreviewUrlSuggestions(HISTORY, query);

describe("resolveOmniboxInput", () => {
  it("types ahead and selects only the part it guessed", () => {
    const state = resolveOmniboxInput({
      value: "local",
      inputType: "insertText",
      caretAtEnd: true,
      suggestions: suggestionsFor("local"),
    });

    expect(state.value).toBe("localhost:3000");
    expect(state.typed).toBe("local");
    expect(state.selection).toEqual({ start: 5, end: "localhost:3000".length });
  });

  it("stays out of the way while the user deletes", () => {
    const state = resolveOmniboxInput({
      value: "local",
      inputType: "deleteContentBackward",
      caretAtEnd: true,
      suggestions: suggestionsFor("local"),
    });

    expect(state).toEqual({ value: "local", typed: "local", selection: null });
  });

  it("does not complete when the caret sits mid-string", () => {
    const state = resolveOmniboxInput({
      value: "local",
      inputType: "insertText",
      caretAtEnd: false,
      suggestions: suggestionsFor("local"),
    });

    expect(state.selection).toBeNull();
    expect(state.value).toBe("local");
  });

  it("leaves an unmatched query alone", () => {
    const state = resolveOmniboxInput({
      value: "example.com",
      inputType: "insertText",
      caretAtEnd: true,
      suggestions: suggestionsFor("example.com"),
    });

    expect(state).toEqual({ value: "example.com", typed: "example.com", selection: null });
  });
});

describe("nextOmniboxHighlight", () => {
  it("walks down the list and back to the input", () => {
    expect(nextOmniboxHighlight(NO_OMNIBOX_HIGHLIGHT, 1, 2)).toBe(0);
    expect(nextOmniboxHighlight(0, 1, 2)).toBe(1);
    expect(nextOmniboxHighlight(1, 1, 2)).toBe(NO_OMNIBOX_HIGHLIGHT);
  });

  it("walks up to the last row and back to the input", () => {
    expect(nextOmniboxHighlight(NO_OMNIBOX_HIGHLIGHT, -1, 2)).toBe(1);
    expect(nextOmniboxHighlight(1, -1, 2)).toBe(0);
    expect(nextOmniboxHighlight(0, -1, 2)).toBe(NO_OMNIBOX_HIGHLIGHT);
  });

  it("has nowhere to go with an empty list", () => {
    expect(nextOmniboxHighlight(NO_OMNIBOX_HIGHLIGHT, 1, 0)).toBe(NO_OMNIBOX_HIGHLIGHT);
  });
});
