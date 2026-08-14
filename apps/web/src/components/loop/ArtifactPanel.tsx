/**
 * An artifact in the right panel, beside the chat that produced it.
 *
 * The Artifacts page is where you go to browse everything; this is where you
 * read the one the agent just made without leaving the conversation. Same two
 * lanes as the full-page viewer — sandboxed `<webview>` for the kinds that can
 * execute, native rendering for the inert ones — because the rule about what
 * may run in this document does not change with the size of the pane.
 *
 * The surface stores only the artifact id (the one field that survives a thread
 * reload), so everything else is resolved here.
 */
import { useCallback, useEffect, useMemo } from "react";
import type { ScopedThreadRef } from "@loop/contracts";
import { FileTextIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { loopSessionIdFor } from "~/loop/handlers/dispatch";

import { isDesktopShell } from "../../env";
import { ArtifactCsv, ArtifactJson, ArtifactMarkdown, ArtifactPlainText } from "./ArtifactContent";
import {
  artifactKindExecutes,
  artifactKindLabel,
  artifactsForSession,
  formatArtifactAge,
  rememberArtifactTitle,
  useArtifact,
  useArtifactContent,
  useLoopArtifacts,
  type LoopArtifact,
} from "./artifacts";

/** Its own store, shared with the full-page viewer. See ArtifactViewer. */
const ARTIFACT_PARTITION = "persist:loop-artifacts";
const ARTIFACT_WEBPREFERENCES = "nodeIntegration=no,contextIsolation=yes,sandbox=yes";

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-4 text-[13px] text-muted-foreground/80">{children}</p>;
}

export function ArtifactPanel({ artifactId }: { readonly artifactId: string }) {
  const { artifact, loading, error } = useArtifact(artifactId);

  // Name the tab as soon as the title is known — it shows the raw id until
  // something records one.
  useEffect(() => {
    if (artifact) rememberArtifactTitle(artifact.id, artifact.title);
  }, [artifact]);

  if (loading) return <Note>Loading…</Note>;
  if (error) return <Note>{`Could not open this artifact: ${error}`}</Note>;
  if (!artifact) return <Note>This artifact no longer exists.</Note>;

  // Created but never filled in. Opening it would show a blank page with no
  // explanation, which reads as the viewer being broken.
  if (!artifact.written) {
    return (
      <Note>{`"${artifact.title}" has no content yet — the agent reserved it but has not written it.`}</Note>
    );
  }

  if (artifactKindExecutes(artifact.kind)) {
    if (!isDesktopShell) return <Note>This artifact can only be shown in the desktop app.</Note>;
    return (
      <webview
        className="min-h-0 flex-1 bg-white"
        partition={ARTIFACT_PARTITION}
        src={artifact.url}
        webpreferences={ARTIFACT_WEBPREFERENCES}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <InertArtifactBody artifactId={artifact.id} kind={artifact.kind} />
    </div>
  );
}

function InertArtifactBody({
  artifactId,
  kind,
}: {
  readonly artifactId: string;
  readonly kind: string;
}) {
  const { content, loading, error } = useArtifactContent(artifactId);
  if (loading) return <Note>Loading…</Note>;
  if (error) return <Note>{`Could not read this artifact: ${error}`}</Note>;
  if (content === null) return null;

  switch (kind) {
    case "markdown":
      return <ArtifactMarkdown content={content} />;
    case "json":
      return <ArtifactJson content={content} />;
    case "csv":
      return <ArtifactCsv content={content} />;
    default:
      return <ArtifactPlainText content={content} />;
  }
}

/**
 * This chat's artifacts, as a panel surface — the index the "+" menu opens.
 *
 * Scoped to the thread, exactly. loop records the session that created each
 * artifact, and the id a thread is known by in this app is NOT always the id
 * loop filed it under — `session.create` can bind one to the other — so the
 * comparison goes through `loopSessionIdFor`, the same translation every other
 * call from this app makes before naming a session to loop. Comparing
 * `threadRef.threadId` directly would silently show an empty panel for any
 * thread whose ids had diverged.
 *
 * Everything ever made lives on the /artifacts page; this panel answers the
 * narrower question you have while reading a conversation.
 */
export function ArtifactsListPanel({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
  const { artifacts, loading, error, reload } = useLoopArtifacts(true);

  const mine = useMemo(
    () => artifactsForSession(artifacts, threadRef ? loopSessionIdFor(threadRef.threadId) : null),
    [artifacts, threadRef],
  );

  const open = useCallback(
    (artifact: LoopArtifact) => {
      if (!threadRef) return;
      rememberArtifactTitle(artifact.id, artifact.title);
      useRightPanelStore.getState().openArtifact(threadRef, artifact.id);
    },
    [threadRef],
  );

  if (loading) return <Note>Loading…</Note>;
  if (error) return <Note>{`loop did not answer: ${error}`}</Note>;
  if (mine.length === 0) {
    return (
      <Note>
        {artifacts.length === 0
          ? "No artifacts yet. Ask for a report, a summary or a write-up and it will appear here."
          : "This chat has not made any artifacts. Older ones are on the Artifacts page in the sidebar."}
      </Note>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground/70">
          {mine.length === 1 ? "1 artifact" : `${mine.length} artifacts`}
        </span>
        <button
          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          onClick={reload}
          type="button"
        >
          Refresh
        </button>
      </div>

      {mine.map((artifact) => (
        <ArtifactListRow artifact={artifact} key={artifact.id} onOpen={open} />
      ))}
    </div>
  );
}

function ArtifactListRow({
  artifact,
  onOpen,
}: {
  readonly artifact: LoopArtifact;
  readonly onOpen: (artifact: LoopArtifact) => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/40 disabled:opacity-60"
      disabled={!artifact.written}
      onClick={() => onOpen(artifact)}
      type="button"
    >
      <span aria-hidden className="w-4 shrink-0 text-center text-sm leading-none">
        {artifact.favicon ?? <FileTextIcon className="mx-auto size-3.5 text-muted-foreground/70" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-foreground">{artifact.title}</span>
        <span className="truncate text-xs text-muted-foreground/60">
          {artifact.written
            ? `${artifactKindLabel(artifact.kind)} · ${formatArtifactAge(artifact.updatedAt)}`
            : "Not written yet"}
        </span>
      </span>
    </button>
  );
}
