/**
 * loop's artifacts, read over loop's own JSON-RPC.
 *
 * Same seam as `settings.ts`, and for the same reason: artifacts are a loop
 * concept with no counterpart in the vendored UI's contract, so routing them
 * through the effect-RPC handler layer would mean inventing a shape and then
 * translating back out of it.
 *
 * Each row carries its own `path` and `url` (loop builds them server-side, in
 * `artifactRow`), so opening one is a shell call with no second round trip.
 * There is no HTTP route serving artifacts — deliberately, since standing a
 * local web server up for a handful of pages is not worth it — which is why the
 * URL is a `file://` one.
 */
import { useCallback, useEffect, useState } from "react";

import { loopCall } from "../../loop/transport";

export interface LoopArtifact {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly favicon?: string;
  readonly kind: "html" | "markdown";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly size: number;
  /** False until the agent has written the file loop reserved for it. */
  readonly written: boolean;
  readonly sessionId?: string;
  /** Absolute path of the content file. */
  readonly path: string;
  /** `file://` URL that opens it. */
  readonly url: string;
}

export interface LoopArtifactsState {
  readonly artifacts: readonly LoopArtifact[];
  readonly loading: boolean;
  /** Set when loop could not be reached; the panel says so rather than lying. */
  readonly error: string | null;
  readonly deleteArtifact: (id: string) => Promise<void>;
  readonly reload: () => void;
}

export function useLoopArtifacts(enabled: boolean): LoopArtifactsState {
  const [artifacts, setArtifacts] = useState<readonly LoopArtifact[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    // Nothing to list while the feature is off, and asking anyway would report
    // an empty list as though the user simply had no artifacts.
    if (!enabled) {
      setArtifacts([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loopCall<readonly LoopArtifact[]>("artifact.list")
      .then((next) => {
        if (cancelled) return;
        setArtifacts(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, generation]);

  // Removed locally first so the row goes as soon as it is clicked, then put
  // back if loop rejects it — the list must never show a state loop is not in.
  const deleteArtifact = useCallback(
    async (id: string) => {
      const previous = artifacts;
      setArtifacts((current) => current.filter((artifact) => artifact.id !== id));
      try {
        await loopCall("artifact.delete", { id });
      } catch (cause) {
        setArtifacts(previous);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [artifacts],
  );

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  return { artifacts, loading, error, deleteArtifact, reload };
}

/**
 * Filter by title and description.
 *
 * Client-side, because `artifact.list` already returned every row: artifacts
 * number in the tens, and a round trip per keystroke would be slower than
 * matching what is already in memory. Every term must match somewhere, so
 * typing more words narrows rather than widens.
 */
export function filterArtifacts(
  artifacts: readonly LoopArtifact[],
  query: string,
): readonly LoopArtifact[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return artifacts;
  return artifacts.filter((artifact) => {
    const haystack = `${artifact.title} ${artifact.description ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Rows per page. Enough to fill a window without turning the page into a scroll. */
export const ARTIFACTS_PAGE_SIZE = 20;

export interface Page<T> {
  readonly items: readonly T[];
  /** 1-based, and always within range — see the clamp below. */
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  /** 1-based inclusive range of the rows on this page; 0/0 when empty. */
  readonly from: number;
  readonly to: number;
}

/**
 * One page of rows.
 *
 * The requested page is CLAMPED rather than trusted. Deleting the last row of
 * the last page, or typing a search that narrows the list, would otherwise
 * leave the caller pointing past the end and rendering nothing at all — which
 * reads as "no artifacts" when the truth is "no artifacts on page 4".
 */
export function paginate<T>(
  items: readonly T[],
  page: number,
  pageSize = ARTIFACTS_PAGE_SIZE,
): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    items: slice,
    page: current,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + slice.length,
  };
}

/** "12.4 KB" — artifacts are pages, so this never needs to reach gigabytes. */
export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Relative age, coarse on purpose — an exact time is noise on a list row. */
export function formatArtifactAge(updatedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(updatedAt).toLocaleDateString();
}
