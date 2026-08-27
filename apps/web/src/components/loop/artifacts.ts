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

/** Kinds loop can produce. Mirrors `ArtifactKind` in core. */
export type LoopArtifactKind = "html" | "markdown" | "svg" | "json" | "csv" | "text";

/**
 * Whether a kind can run code, and therefore must be shown in the sandboxed
 * `<webview>` rather than rendered by the app. Mirrors `ARTIFACT_KIND_EXECUTES`
 * in core — `svg` counts, because an SVG document can carry `<script>`.
 */
export function artifactKindExecutes(kind: LoopArtifactKind): boolean {
  return kind === "html" || kind === "svg";
}

/** What a row calls each kind. Exhaustive, so a new kind fails the typecheck here. */
const KIND_LABEL: Record<LoopArtifactKind, string> = {
  html: "Page",
  markdown: "Document",
  svg: "Diagram",
  json: "JSON",
  csv: "Table",
  text: "Text",
};

export function artifactKindLabel(kind: LoopArtifactKind): string {
  return KIND_LABEL[kind] ?? "File";
}

export interface LoopArtifact {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly favicon?: string;
  readonly kind: LoopArtifactKind;
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
 * The `artifact` tool result, as the transcript needs it.
 *
 * Ported from `parseArtifactResult` in core (tools/artifact.ts) for the same
 * reason as loopToolSummary and loopVerbGroup: the core module is a Node tree.
 * KEEP IN SYNC — the separator is the contract between them.
 */
const ARTIFACT_RESULT_SEPARATOR = "\n artifact:";

/**
 * Everything but `id` and `title` is optional: the JSON payload does not
 * survive a thread reload, and what gets rebuilt from the persisted summary has
 * only those two. A card needs no more — it opens by id.
 */
export interface ArtifactResultPayload {
  readonly id: string;
  readonly title: string;
  readonly kind?: LoopArtifactKind;
  readonly description?: string;
  readonly favicon?: string;
  readonly path?: string;
  readonly url?: string;
}

/** The id and title as the persisted summary states them. */
const ARTIFACT_SUMMARY_RE = /artifact "([^"]+)" \(([a-f0-9]{12})\)/;

/**
 * The card payload in a tool result, or null for anything else.
 *
 * Two sources, because the JSON is LIVE-ONLY: loop keeps it out of the model's
 * context, and the AI SDK persists the model-facing value — so a reloaded
 * thread has only the summary. Without the fallback the card would appear while
 * the turn ran and be gone the next time the thread was opened.
 */
export function parseArtifactResult(output: unknown): ArtifactResultPayload | null {
  if (typeof output !== "string") return null;
  const at = output.indexOf(ARTIFACT_RESULT_SEPARATOR);
  if (at >= 0) {
    try {
      const payload = JSON.parse(
        output.slice(at + ARTIFACT_RESULT_SEPARATOR.length),
      ) as ArtifactResultPayload;
      if (payload && typeof payload.id === "string" && typeof payload.title === "string") {
        return payload;
      }
    } catch {
      // Truncated in transit — fall through and rebuild from the summary.
    }
  }
  const match = ARTIFACT_SUMMARY_RE.exec(output);
  return match ? { id: match[2]!, title: match[1]! } : null;
}

/** The human half of the result — what a row shows when there is no card. */
export function artifactResultSummary(output: string): string {
  const at = output.indexOf(ARTIFACT_RESULT_SEPARATOR);
  return at < 0 ? output : output.slice(0, at);
}

/**
 * Copy an artifact into a real folder and report where it landed.
 *
 * Server-side on purpose. The browser route — Blob plus `<a download>` — goes
 * through Electron's `will-download`, and loop's preload exposes no handler for
 * it, so it would either do nothing or land somewhere with no way to say where.
 * loop's own process has the filesystem, so it does the copy and returns the
 * path, which is the only part the UI actually needs to show.
 */
export async function exportArtifact(id: string): Promise<string> {
  const { path } = await loopCall<{ path: string }>("artifact.export", { id });
  return path;
}

/**
 * Titles seen this session, so a panel tab can be named before its content
 * loads.
 *
 * The surface stores only the artifact id — the one field that survives a
 * thread reload — and a tab reading `a1b2c3d4e5f6` says nothing. Whoever knows
 * a title (the chip that opened it, the panel once it has loaded) records it
 * here; the tab falls back to the id until someone does.
 */
const titlesById = new Map<string, string>();

export function rememberArtifactTitle(id: string, title: string): void {
  titlesById.set(id, title);
}

export function artifactTitle(id: string): string | undefined {
  return titlesById.get(id);
}

/**
 * Hand-off for "open this artifact" across a navigation.
 *
 * A card in the transcript has to get the Artifacts page to open one specific
 * artifact, and the page is a different route. No route in this app declares
 * search params, so rather than introduce that pattern for one link, the id is
 * parked here and claimed by the page as it mounts — which is exactly when it
 * arrives, since the click navigates away from a chat route.
 */
let pendingOpenId: string | null = null;

/** Read once and clear, so a later visit to the page does not reopen it. */
export function takePendingArtifactId(): string | null {
  const id = pendingOpenId;
  pendingOpenId = null;
  return id;
}

/**
 * The artifact's bytes.
 *
 * Needed because the non-executable kinds are rendered by the app itself, and a
 * component in the page cannot open a `file://` URL — only the sandboxed
 * `<webview>` can, which is exactly the lane these kinds are kept out of.
 */
export async function readArtifactContent(id: string): Promise<string> {
  const row = await loopCall<{ content: string }>("artifact.read", { id });
  return row.content;
}

/** One artifact's metadata, by id — what a panel needs before it can render. */
export function useArtifact(id: string | null): {
  readonly artifact: LoopArtifact | null;
  readonly loading: boolean;
  readonly error: string | null;
} {
  const [artifact, setArtifact] = useState<LoopArtifact | null>(null);
  const [loading, setLoading] = useState(id !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === null) {
      setArtifact(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loopCall<LoopArtifact>("artifact.get", { id })
      .then((next) => {
        if (cancelled) return;
        setArtifact(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setArtifact(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return { artifact, loading, error };
}

/** One artifact's content, loaded on demand. Null id = nothing open. */
export function useArtifactContent(id: string | null): {
  readonly content: string | null;
  readonly loading: boolean;
  readonly error: string | null;
} {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === null) {
      setContent(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // Cleared up front: leaving the previous artifact's text on screen while
    // the next one loads reads as the new one having that content.
    setContent(null);
    void readArtifactContent(id)
      .then((next) => {
        if (cancelled) return;
        setContent(next);
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
  }, [id]);

  return { content, loading, error };
}

/**
 * The artifacts one session produced.
 *
 * `sessionId` is loop's id for the session, which is not always the id this app
 * knows the thread by — `session.create` can bind one to the other. Callers
 * must pass the TRANSLATED id (`loopSessionIdFor(threadId)`), never
 * `threadRef.threadId` raw, or a thread whose ids had diverged would show an
 * empty panel with nothing to explain it.
 *
 * An artifact with no `sessionId` belongs to no chat — made before the field
 * existed, or by a headless run — so it never matches a session.
 */
export function artifactsForSession(
  artifacts: readonly LoopArtifact[],
  sessionId: string | null,
): readonly LoopArtifact[] {
  if (!sessionId) return [];
  return artifacts.filter((artifact) => artifact.sessionId === sessionId);
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
