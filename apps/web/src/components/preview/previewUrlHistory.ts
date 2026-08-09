/**
 * Address-bar history: what the preview browser has visited, and how a typed
 * query turns into ranked suggestions plus a browser-style inline completion.
 *
 * Ranking is deliberately clock-free — recency is the entry's position in the
 * visit order, not a wall-clock delta — so suggestions are reproducible and
 * testable without freezing time.
 */

export interface PreviewUrlHistoryEntry {
  /** Absolute href exactly as the page committed it. */
  readonly url: string;
  readonly title: string;
  readonly visits: number;
  /** Epoch millis of the most recent visit. Used for ordering, never for decay. */
  readonly lastVisitedAt: number;
}

export interface PreviewUrlSuggestionMatch {
  readonly start: number;
  readonly end: number;
}

export interface PreviewUrlSuggestion {
  readonly url: string;
  readonly title: string;
  /** Omnibox form — scheme and a leading `www.` dropped. What we complete to. */
  readonly typed: string;
  readonly visits: number;
  /** Range within `typed` the query matched, so the list can emphasise it. */
  readonly match: PreviewUrlSuggestionMatch | null;
}

export interface PreviewUrlInlineCompletion {
  readonly suggestion: PreviewUrlSuggestion;
  /** The full input value: the query verbatim, plus the completed remainder. */
  readonly value: string;
}

export const PREVIEW_URL_HISTORY_LIMIT = 200;
export const PREVIEW_URL_SUGGESTION_LIMIT = 8;

const SCHEME_PATTERN = /^https?:\/\//i;
const WWW_PATTERN = /^www\./i;

/** Visits cap out so a page opened all day can't outrank an exact prefix hit. */
const VISIT_SCORE_CAP = 50;
const MATCH_WEIGHT = 1_000_000;
const VISIT_WEIGHT = 1_000;

const MATCH_EXACT_PREFIX = 3;
const MATCH_HOST_PREFIX = 2;
const MATCH_SUBSTRING = 1;
const MATCH_TITLE = 0.5;

/**
 * The form the address bar shows and completes to: `https://www.a.dev/b` reads
 * as `a.dev/b`. A bare root slash is dropped, deeper paths keep theirs.
 */
export function previewUrlTypedForm(url: string): string {
  const withoutScheme = url.replace(SCHEME_PATTERN, "").replace(WWW_PATTERN, "");
  if (!withoutScheme.endsWith("/")) return withoutScheme;
  const withoutTrailingSlash = withoutScheme.slice(0, -1);
  return withoutTrailingSlash.includes("/") ? withoutScheme : withoutTrailingSlash;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(SCHEME_PATTERN, "").replace(WWW_PATTERN, "").toLowerCase();
}

function isRecordableUrl(url: string): boolean {
  return SCHEME_PATTERN.test(url.trim());
}

export function recordPreviewUrlVisit(
  entries: ReadonlyArray<PreviewUrlHistoryEntry>,
  visit: { readonly url: string; readonly title?: string; readonly at: number },
  limit: number = PREVIEW_URL_HISTORY_LIMIT,
): ReadonlyArray<PreviewUrlHistoryEntry> {
  const url = visit.url.trim();
  if (!isRecordableUrl(url)) return entries;

  const previous = entries.find((entry) => entry.url === url);
  const title = visit.title?.trim();
  const next: PreviewUrlHistoryEntry = {
    url,
    // A committed page can report an empty title mid-load; keep the last one
    // we knew rather than blanking a row the user recognises.
    title: title || previous?.title || "",
    visits: (previous?.visits ?? 0) + 1,
    lastVisitedAt: visit.at,
  };
  return [next, ...entries.filter((entry) => entry.url !== url)].slice(0, limit);
}

interface ScoredSuggestion {
  readonly suggestion: PreviewUrlSuggestion;
  readonly score: number;
}

function scoreEntry(
  entry: PreviewUrlHistoryEntry,
  query: string,
  recencyRank: number,
): ScoredSuggestion | null {
  const typed = previewUrlTypedForm(entry.url);
  const frecency = Math.min(entry.visits, VISIT_SCORE_CAP) * VISIT_WEIGHT + recencyRank;
  const base = { url: entry.url, title: entry.title, typed, visits: entry.visits };

  if (query.length === 0) {
    return { suggestion: { ...base, match: null }, score: frecency };
  }

  const lowerTyped = typed.toLowerCase();
  if (lowerTyped.startsWith(query)) {
    return {
      suggestion: { ...base, match: { start: 0, end: query.length } },
      score: MATCH_EXACT_PREFIX * MATCH_WEIGHT + frecency,
    };
  }

  // `localhost:3000/deep/path` should still surface when the user types the
  // host of a page they only ever reached deep-linked.
  const host = lowerTyped.split("/")[0] ?? "";
  if (host.startsWith(query)) {
    return {
      suggestion: { ...base, match: { start: 0, end: query.length } },
      score: MATCH_HOST_PREFIX * MATCH_WEIGHT + frecency,
    };
  }

  const index = lowerTyped.indexOf(query);
  if (index >= 0) {
    return {
      suggestion: { ...base, match: { start: index, end: index + query.length } },
      score: MATCH_SUBSTRING * MATCH_WEIGHT + frecency,
    };
  }

  if (entry.title.toLowerCase().includes(query)) {
    return { suggestion: { ...base, match: null }, score: MATCH_TITLE * MATCH_WEIGHT + frecency };
  }

  return null;
}

export function matchPreviewUrlSuggestions(
  entries: ReadonlyArray<PreviewUrlHistoryEntry>,
  query: string,
  options: { readonly limit?: number; readonly exclude?: string | null } = {},
): ReadonlyArray<PreviewUrlSuggestion> {
  const limit = options.limit ?? PREVIEW_URL_SUGGESTION_LIMIT;
  if (limit <= 0) return [];
  const normalizedQuery = normalizeQuery(query);
  const exclude = options.exclude?.trim();

  // Recency is a rank over the visit order, so it can never outweigh a match
  // class the way an unbounded timestamp difference would.
  const byRecency = entries.toSorted((a, b) => b.lastVisitedAt - a.lastVisitedAt);
  const scored: ScoredSuggestion[] = [];
  for (const [index, entry] of byRecency.entries()) {
    if (exclude && entry.url === exclude) continue;
    const candidate = scoreEntry(entry, normalizedQuery, byRecency.length - index);
    if (candidate) scored.push(candidate);
  }

  return scored
    .toSorted((a, b) => b.score - a.score || a.suggestion.url.localeCompare(b.suggestion.url))
    .slice(0, limit)
    .map(({ suggestion }) => suggestion);
}

/**
 * Chrome-style type-ahead: the first suggestion the query is a live prefix of,
 * completed against either its omnibox form or its full href, so typing
 * `local` and typing `http://local` both complete sensibly. The query is
 * returned verbatim — only the remainder comes from history — so the caller can
 * select exactly what it appended.
 */
export function previewUrlInlineCompletion(
  query: string,
  suggestions: ReadonlyArray<PreviewUrlSuggestion>,
): PreviewUrlInlineCompletion | null {
  if (query.trim().length === 0 || query !== query.trimStart()) return null;
  const lowerQuery = query.toLowerCase();
  for (const suggestion of suggestions) {
    for (const candidate of [suggestion.typed, suggestion.url]) {
      if (candidate.length <= query.length) continue;
      if (!candidate.toLowerCase().startsWith(lowerQuery)) continue;
      return { suggestion, value: query + candidate.slice(query.length) };
    }
  }
  return null;
}
