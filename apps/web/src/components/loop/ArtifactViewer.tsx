/**
 * The artifact viewer — loop's own browser pane, on the Artifacts page.
 *
 * **Why this exists rather than a shell open.** The desktop shell refuses to
 * hand anything but `http(s)` to the OS opener (`main.ts`, the
 * `loop:update.openExternal` handler), deliberately: passing an arbitrary
 * string to the system opener is how a `file:` or custom-scheme URL turns into
 * launching something local. Artifacts are `file://` URLs, so `openExternal`
 * silently refused them and clicking a row did nothing. Widening that guard to
 * satisfy this page would trade a real safety property for a convenience, so
 * the page brings its own browser instead.
 *
 * **Why not the thread browser panel.** `openFileInPreview` drives the existing
 * panel, but that panel is thread-scoped all the way down — the tab registry is
 * keyed by `threadId`, the `<webview>` is hosted inside a thread's right panel,
 * and it leases a desktop tab per environment. The Artifacts page is a
 * destination of its own with no thread, so it hosts a plain `<webview>`
 * directly. `webviewTag` is already enabled for the preview panel.
 *
 * **The guest is untrusted.** An artifact is a page a language model wrote. It
 * gets its own partition (nothing shared with the app or with preview tabs), no
 * preload, no node integration, and a sandbox — so the worst a bad artifact can
 * do is render badly.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, CheckIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ArtifactCsv, ArtifactJson, ArtifactMarkdown, ArtifactPlainText } from "./ArtifactContent";
import {
  artifactKindExecutes,
  exportArtifact,
  useArtifactContent,
  type LoopArtifact,
} from "./artifacts";

/**
 * Its own store, sharing nothing with the app or with the thread browser's
 * tabs. `persist:` so a reopened artifact keeps whatever it put in
 * localStorage, which a page with client-side state will expect.
 */
const ARTIFACT_PARTITION = "persist:loop-artifacts";

/** No node, no shared context, sandboxed. See the note above on trust. */
const ARTIFACT_WEBPREFERENCES = "nodeIntegration=no,contextIsolation=yes,sandbox=yes";

// The `webview` element's type is declared once, globally, by
// browser/HostedBrowserWebview.tsx. Redeclaring it here collides with that.

export function ArtifactViewer({
  artifact,
  onBack,
}: {
  readonly artifact: LoopArtifact;
  readonly onBack: () => void;
}) {
  // Remounting is what actually re-reads the file: the agent may have edited
  // the artifact since it was opened, and a `src` that has not changed will
  // not re-fetch on its own.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const executes = artifactKindExecutes(artifact.kind);
  // The header has no room for a path, so the tick plus its tooltip carries it.
  const [saved, setSaved] = useState<string | null>(null);
  const download = useCallback(() => {
    void exportArtifact(artifact.id)
      .then(setSaved)
      .catch(() => setSaved(null));
  }, [artifact.id]);

  // Escape leaves the viewer, the way it closes every other overlay here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2 sm:px-4">
        <Button aria-label="Back to artifacts" onClick={onBack} size="icon" variant="ghost">
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">{artifact.title}</span>
          {artifact.description ? (
            <span className="truncate text-xs text-muted-foreground/70">
              {artifact.description}
            </span>
          ) : null}
        </div>
        <Button
          aria-label={saved ? `Saved to ${saved}` : `Download ${artifact.title}`}
          onClick={download}
          size="icon"
          title={saved ? `Saved to ${saved}` : "Download a copy"}
          variant="ghost"
        >
          {saved ? (
            <CheckIcon className="size-4 text-success" />
          ) : (
            <DownloadIcon className="size-4" />
          )}
        </Button>
        <Button aria-label="Reload artifact" onClick={reload} size="icon" variant="ghost">
          <RefreshCwIcon className="size-4" />
        </Button>
      </div>

      {executes ? (
        // html and svg can carry script, so they only ever render inside the
        // sandbox — never in this document.
        <webview
          key={generation}
          className="min-h-0 flex-1 bg-white"
          partition={ARTIFACT_PARTITION}
          src={artifact.url}
          webpreferences={ARTIFACT_WEBPREFERENCES}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" key={generation}>
          <InertArtifact artifact={artifact} />
        </div>
      )}
    </div>
  );
}

/**
 * The kinds the app renders itself.
 *
 * Content arrives over RPC rather than from the file, because a component in
 * this document cannot read a `file://` URL — only the webview can, and these
 * kinds are deliberately kept out of it.
 */
function InertArtifact({ artifact }: { readonly artifact: LoopArtifact }) {
  const { content, loading, error } = useArtifactContent(artifact.id);

  if (loading) return <Note>Loading…</Note>;
  if (error) return <Note>{`Could not read this artifact: ${error}`}</Note>;
  if (content === null) return null;

  switch (artifact.kind) {
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

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-6 text-[13px] text-muted-foreground/80">{children}</p>;
}
