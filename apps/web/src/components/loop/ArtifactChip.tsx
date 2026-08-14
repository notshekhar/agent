/**
 * The card an `artifact` tool call leaves in the transcript.
 *
 * Before this, the only trace of a new artifact in the chat was whatever the
 * model chose to type — usually a raw
 * `file:///Users/…/artifacts/a1b2c3d4e5f6/index.html`, which is unclickable in
 * a terminal and, in the app, a string sitting next to nothing that opens it.
 * The tool no longer tells the model that URL at all (see
 * ARTIFACT_RESULT_SEPARATOR in core); it goes to the renderer instead, and the
 * renderer is this.
 *
 * Clicking opens it in the RIGHT PANEL, beside the conversation — not in the OS
 * browser (the desktop shell refuses `file:` to the system opener) and not by
 * navigating to the Artifacts page, which would leave the chat you are reading
 * it against. That page is for browsing everything; this is for reading the one
 * that was just made.
 */
import { useCallback } from "react";
import type { ScopedThreadRef } from "@loop/contracts";
import { FileTextIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { artifactKindLabel, rememberArtifactTitle, type ArtifactResultPayload } from "./artifacts";

export function ArtifactChip({
  artifact,
  threadRef,
}: {
  readonly artifact: ArtifactResultPayload;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const open = useCallback(() => {
    if (!threadRef) return;
    // Recorded before opening so the tab is named immediately rather than
    // showing the raw id until the panel has fetched it.
    rememberArtifactTitle(artifact.id, artifact.title);
    useRightPanelStore.getState().openArtifact(threadRef, artifact.id);
  }, [artifact.id, artifact.title, threadRef]);

  return (
    <button
      className="group my-1 flex w-full max-w-md items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-border/80 hover:bg-accent/50 disabled:opacity-70"
      disabled={!threadRef}
      onClick={open}
      title={threadRef ? `Open ${artifact.title}` : artifact.title}
      type="button"
    >
      <span aria-hidden className="w-5 shrink-0 text-center text-base leading-none">
        {artifact.favicon ?? <FileTextIcon className="mx-auto size-4 text-muted-foreground/70" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">{artifact.title}</span>
        <span className="truncate text-xs text-muted-foreground/70">
          {artifact.description ??
            (artifact.kind
              ? `${artifactKindLabel(artifact.kind)} · click to open`
              : "Click to open")}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground/50 transition-colors group-hover:text-muted-foreground">
        Open
      </span>
    </button>
  );
}
