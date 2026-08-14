/**
 * The Artifacts panel — pages the agent wrote, listed so you can open them.
 *
 * Artifacts live outside any repo (under loop's config dir) and are opened from
 * disk rather than served, so a row's action is a shell open of its `file://`
 * URL. Nothing here reads the content: the browser renders HTML, and a markdown
 * artifact opens as its source, which is the honest consequence of not running
 * a server for this.
 *
 * The feature is off by default, so the first thing this panel has to handle is
 * the case where there is nothing to list BECAUSE it was never turned on. That
 * is a different empty state from "you have no artifacts yet", and conflating
 * the two would leave someone waiting for a list that can never arrive — so the
 * off state explains the feature and offers the switch inline rather than
 * sending anyone to Settings to find it.
 */
import { useCallback, useMemo, useState } from "react";
import {
  BookOpenIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  LayersIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";

// `isDesktopShell`, not `isElectron`: the latter tests upstream's
// `window.desktopBridge`, which loop's preload does not expose, so it is false
// inside loop's own desktop app — see env.ts. The `<webview>` the viewer needs
// exists exactly when we are in that shell.
import { isDesktopShell } from "../../env";
import { Button } from "../ui/button";
import { ArtifactViewer } from "./ArtifactViewer";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Input } from "../ui/input";
import {
  filterArtifacts,
  formatArtifactAge,
  formatArtifactSize,
  paginate,
  useLoopArtifacts,
  type LoopArtifact,
} from "./artifacts";
import { useLoopSettings } from "./settings";

const ARTIFACTS_SETTING_KEY = "artifacts";

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-[13px] text-muted-foreground/80 sm:px-4">{children}</p>;
}

/** Shown when the feature is off: what it is, and the switch that enables it. */
function ArtifactsDisabled({
  busy,
  onEnable,
}: {
  readonly busy: boolean;
  readonly onEnable: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-3 py-4 sm:px-4">
      <p className="text-[13px] text-muted-foreground/90">
        Artifacts are standalone pages the agent writes for you — a report, a summary, a write-up —
        kept outside your project and openable in a browser. Turn this on and the agent can create
        one when you ask for a document rather than code.
      </p>
      <div className="flex items-center gap-3">
        <Switch
          aria-label="Enable artifacts"
          checked={false}
          disabled={busy}
          onCheckedChange={() => onEnable()}
        />
        <span className="text-[13px] font-medium text-foreground">Enable artifacts</span>
      </div>
      <p className="text-xs text-muted-foreground/70">
        You can turn it off again any time in Settings.
      </p>
    </div>
  );
}

function ArtifactRow({
  artifact,
  onDelete,
  onOpen,
}: {
  readonly artifact: LoopArtifact;
  readonly onDelete: (id: string) => void;
  readonly onOpen: (artifact: LoopArtifact) => void;
}) {
  const open = useCallback(() => onOpen(artifact), [artifact, onOpen]);
  const remove = useCallback(() => onDelete(artifact.id), [artifact.id, onDelete]);

  return (
    <div className="group flex items-center gap-3 border-b border-border/40 px-3 py-2.5 last:border-b-0 sm:px-4">
      <span aria-hidden className="w-5 shrink-0 text-center text-base leading-none">
        {artifact.favicon ?? <FileTextIcon className="mx-auto size-4 text-muted-foreground/70" />}
      </span>

      <button
        className="flex min-w-0 flex-1 flex-col items-start text-left enabled:cursor-pointer disabled:opacity-70"
        // An artifact with no content file yet is one the agent reserved and
        // has not written — opening it would hand the browser a missing path.
        disabled={!artifact.written}
        onClick={open}
        title={artifact.written ? `Open ${artifact.title}` : undefined}
        type="button"
      >
        <span className="w-full truncate text-[13px] font-medium text-foreground">
          {artifact.title}
        </span>
        <span className="w-full truncate text-xs text-muted-foreground/70">
          {artifact.written
            ? `${artifact.kind === "html" ? "Page" : "Markdown"} · ${formatArtifactSize(artifact.size)} · ${formatArtifactAge(artifact.updatedAt)}`
            : "Waiting for the agent to write it"}
        </span>
      </button>

      {/* The whole row opens, but a row that only opens on click is a row
          nobody clicks — the explicit control is what says it is openable. */}
      {artifact.written ? (
        <Button
          aria-label={`Open ${artifact.title}`}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={open}
          size="icon"
          variant="ghost"
        >
          <BookOpenIcon className="size-4" />
        </Button>
      ) : null}

      <Button
        aria-label={`Delete ${artifact.title}`}
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        onClick={remove}
        size="icon"
        variant="ghost"
      >
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  );
}

/** "21–40 of 57", with the page controls. Hidden when everything fits on one page. */
function Pager({
  from,
  onPage,
  page,
  pageCount,
  to,
  total,
}: {
  readonly from: number;
  readonly onPage: (page: number) => void;
  readonly page: number;
  readonly pageCount: number;
  readonly to: number;
  readonly total: number;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
      <span className="text-xs text-muted-foreground/70">{`${from}–${to} of ${total}`}</span>
      <div className="flex items-center gap-1">
        <Button
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          size="icon"
          variant="ghost"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <span className="min-w-16 text-center text-xs text-muted-foreground/70">
          {`Page ${page} of ${pageCount}`}
        </span>
        <Button
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
          size="icon"
          variant="ghost"
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function LoopArtifacts() {
  const { settings, loading: settingsLoading, setSetting } = useLoopSettings();
  const [enabling, setEnabling] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [openedId, setOpenedId] = useState<string | null>(null);

  const setting = settings.find((entry) => entry.key === ARTIFACTS_SETTING_KEY);
  // Absent means an older loop that predates the setting — treat that as off
  // rather than showing a list that can never fill.
  const enabled = setting?.value === true;

  const { artifacts, loading, error, deleteArtifact, reload } = useLoopArtifacts(enabled);

  const matches = useMemo(() => filterArtifacts(artifacts, query), [artifacts, query]);
  // `paginate` clamps, so deleting the last row of the last page — or narrowing
  // the search until the current page no longer exists — lands on a real page
  // instead of rendering an empty list that reads as "no artifacts".
  const view = useMemo(() => paginate(matches, page), [matches, page]);

  const search = useCallback((value: string) => {
    setQuery(value);
    // A new search is a new list; staying on page 3 of the old one would show
    // results the user cannot see the start of.
    setPage(1);
  }, []);

  const enable = useCallback(() => {
    setEnabling(true);
    void setSetting(ARTIFACTS_SETTING_KEY, true).finally(() => setEnabling(false));
  }, [setSetting]);

  const openArtifact = useCallback((artifact: LoopArtifact) => setOpenedId(artifact.id), []);
  const closeArtifact = useCallback(() => setOpenedId(null), []);

  // Resolved from the live list rather than held as an object, so an artifact
  // deleted (or reloaded) while open closes the viewer instead of leaving it
  // pointed at a file that is gone.
  const opened = openedId === null ? null : (artifacts.find((a) => a.id === openedId) ?? null);
  if (opened && isDesktopShell) return <ArtifactViewer artifact={opened} onBack={closeArtifact} />;

  return (
    <SettingsPageContainer>
      <SettingsSection
        headerAction={
          enabled ? (
            <Button aria-label="Refresh" onClick={reload} size="icon" variant="ghost">
              <RefreshCwIcon className="size-4" />
            </Button>
          ) : undefined
        }
        icon={<LayersIcon className="size-4" />}
        title="Artifacts"
      >
        {settingsLoading ? (
          <Note>Reading settings from loop…</Note>
        ) : !enabled ? (
          <ArtifactsDisabled busy={enabling} onEnable={enable} />
        ) : error ? (
          <Note>{`loop did not answer: ${error}`}</Note>
        ) : loading ? (
          <Note>Loading artifacts…</Note>
        ) : artifacts.length === 0 ? (
          <Note>
            No artifacts yet. Ask the agent for a report, a summary, or a write-up and it will
            create one here.
          </Note>
        ) : (
          <>
            {/* Only worth the row once there is enough to sift through. */}
            {artifacts.length > 1 ? (
              <div className="relative px-3 pb-1 sm:px-4">
                <SearchIcon className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60 sm:left-7" />
                <Input
                  aria-label="Search artifacts"
                  className="pl-9"
                  onChange={(event) => search(event.target.value)}
                  placeholder="Search artifacts…"
                  type="search"
                  value={query}
                />
              </div>
            ) : null}

            {/* Opening needs a <webview>, which only the desktop shell has. In
                a browser a file:// URL cannot be navigated to at all, so say so
                once rather than offering rows that quietly do nothing. */}
            {!isDesktopShell ? (
              <Note>
                Artifacts open in the desktop app. Their files are on this machine, under loop's
                config directory.
              </Note>
            ) : null}

            {view.total === 0 ? (
              <Note>{`Nothing matches “${query}”.`}</Note>
            ) : (
              view.items.map((artifact) => (
                <ArtifactRow
                  artifact={artifact}
                  key={artifact.id}
                  onDelete={deleteArtifact}
                  onOpen={openArtifact}
                />
              ))
            )}

            <Pager
              from={view.from}
              onPage={setPage}
              page={view.page}
              pageCount={view.pageCount}
              to={view.to}
              total={view.total}
            />
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
