import { describe, expect, it } from "vite-plus/test";

import {
  matchPreviewUrlSuggestions,
  previewUrlInlineCompletion,
  previewUrlTypedForm,
  recordPreviewUrlVisit,
  type PreviewUrlHistoryEntry,
} from "./previewUrlHistory";

function entry(
  url: string,
  overrides: Partial<Omit<PreviewUrlHistoryEntry, "url">> = {},
): PreviewUrlHistoryEntry {
  return {
    url,
    title: overrides.title ?? "",
    visits: overrides.visits ?? 1,
    lastVisitedAt: overrides.lastVisitedAt ?? 0,
  };
}

const HISTORY: ReadonlyArray<PreviewUrlHistoryEntry> = [
  entry("http://localhost:3000/", { title: "Home", visits: 9, lastVisitedAt: 300 }),
  entry("http://localhost:3000/settings", { title: "Settings", visits: 2, lastVisitedAt: 400 }),
  entry("http://localhost:5173/", { title: "Vite app", visits: 1, lastVisitedAt: 200 }),
  entry("https://www.example.com/docs", { title: "Docs", visits: 4, lastVisitedAt: 100 }),
];

describe("previewUrlTypedForm", () => {
  it("drops the scheme, a leading www, and a bare root slash", () => {
    expect(previewUrlTypedForm("http://localhost:3000/")).toBe("localhost:3000");
    expect(previewUrlTypedForm("https://www.example.com/")).toBe("example.com");
  });

  it("keeps the trailing slash of a deeper path", () => {
    expect(previewUrlTypedForm("https://example.com/docs/")).toBe("example.com/docs/");
  });
});

describe("recordPreviewUrlVisit", () => {
  it("counts repeat visits and moves the entry to the front", () => {
    const first = recordPreviewUrlVisit([], { url: "http://localhost:3000/", at: 1 });
    const second = recordPreviewUrlVisit(first, { url: "http://localhost:5173/", at: 2 });
    const third = recordPreviewUrlVisit(second, { url: "http://localhost:3000/", at: 3 });

    expect(third.map((item) => item.url)).toEqual([
      "http://localhost:3000/",
      "http://localhost:5173/",
    ]);
    expect(third[0]).toMatchObject({ visits: 2, lastVisitedAt: 3 });
  });

  it("keeps the last known title when a reload reports an empty one", () => {
    const first = recordPreviewUrlVisit([], {
      url: "http://localhost:3000/",
      title: "Home",
      at: 1,
    });
    const second = recordPreviewUrlVisit(first, {
      url: "http://localhost:3000/",
      title: "",
      at: 2,
    });

    expect(second[0]?.title).toBe("Home");
  });

  it("ignores anything that isn't http(s) and trims the tail at the limit", () => {
    expect(recordPreviewUrlVisit([], { url: "about:blank", at: 1 })).toEqual([]);
    expect(recordPreviewUrlVisit([], { url: "", at: 1 })).toEqual([]);

    const filled = Array.from({ length: 3 }, (_, index) =>
      entry(`http://localhost:300${index}/`, { lastVisitedAt: index }),
    );
    const capped = recordPreviewUrlVisit(filled, { url: "http://localhost:9999/", at: 9 }, 3);
    expect(capped.map((item) => item.url)).toEqual([
      "http://localhost:9999/",
      "http://localhost:3000/",
      "http://localhost:3001/",
    ]);
  });
});

describe("matchPreviewUrlSuggestions", () => {
  it("ranks a prefix of the omnibox form above a host-only or substring hit", () => {
    const matches = matchPreviewUrlSuggestions(HISTORY, "localhost:3000/s");
    expect(matches[0]?.url).toBe("http://localhost:3000/settings");
    expect(matches[0]?.match).toEqual({ start: 0, end: "localhost:3000/s".length });
  });

  it("prefers the more-visited page when both match the host", () => {
    const matches = matchPreviewUrlSuggestions(HISTORY, "localhost:3000");
    expect(matches.map((item) => item.url)).toEqual([
      "http://localhost:3000/",
      "http://localhost:3000/settings",
    ]);
  });

  it("ignores the scheme and www the user typed", () => {
    const matches = matchPreviewUrlSuggestions(HISTORY, "https://www.example.com");
    expect(matches.map((item) => item.url)).toEqual(["https://www.example.com/docs"]);
  });

  it("falls back to the page title", () => {
    const matches = matchPreviewUrlSuggestions(HISTORY, "vite");
    expect(matches.map((item) => item.url)).toEqual(["http://localhost:5173/"]);
    expect(matches[0]?.match).toBeNull();
  });

  it("returns the most recent pages, minus the one already open, for an empty query", () => {
    const matches = matchPreviewUrlSuggestions(HISTORY, "   ", {
      exclude: "http://localhost:3000/settings",
    });
    expect(matches[0]?.url).toBe("http://localhost:3000/");
    expect(matches.some((item) => item.url === "http://localhost:3000/settings")).toBe(false);
  });

  it("honours the limit", () => {
    expect(matchPreviewUrlSuggestions(HISTORY, "", { limit: 2 })).toHaveLength(2);
    expect(matchPreviewUrlSuggestions(HISTORY, "", { limit: 0 })).toEqual([]);
  });

  it("returns nothing when the query matches no page", () => {
    expect(matchPreviewUrlSuggestions(HISTORY, "nope.invalid")).toEqual([]);
  });
});

describe("previewUrlInlineCompletion", () => {
  const suggestionsFor = (query: string) => matchPreviewUrlSuggestions(HISTORY, query);

  it("completes the omnibox form and keeps what was typed verbatim", () => {
    const completion = previewUrlInlineCompletion("LOCAL", suggestionsFor("LOCAL"));
    expect(completion?.value).toBe("LOCALhost:3000");
    expect(completion?.suggestion.url).toBe("http://localhost:3000/");
  });

  it("completes a full href once the user types the scheme", () => {
    const query = "http://localhost:3000/s";
    const completion = previewUrlInlineCompletion(query, suggestionsFor(query));
    expect(completion?.value).toBe("http://localhost:3000/settings");
  });

  it("does not complete an exact match, an empty query, or a substring-only hit", () => {
    const exact = previewUrlInlineCompletion("localhost:3000", suggestionsFor("localhost:3000"));
    expect(exact?.value).toBe("localhost:3000/settings");
    expect(previewUrlInlineCompletion("", suggestionsFor(""))).toBeNull();
    expect(previewUrlInlineCompletion("   ", suggestionsFor("   "))).toBeNull();
    expect(previewUrlInlineCompletion("settings", suggestionsFor("settings"))).toBeNull();
  });
});
