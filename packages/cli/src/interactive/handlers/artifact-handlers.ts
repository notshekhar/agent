/**
 * /artifacts: the pages the agent wrote, and a way into them.
 *
 * Artifacts are stored on disk and opened from disk — there is no HTTP route
 * serving them (see core's artifacts module on why a local web server is not
 * worth standing up for a handful of pages). So picking one hands its
 * `file://` URL to the OS browser, which is what "open it" means in a
 * terminal. The path is printed either way: `openBrowser` is best-effort and
 * cannot tell whether a tab actually appeared, and over SSH there is no
 * browser to open at all — a path the user can copy is the honest fallback.
 */
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    artifactFilePath,
    deleteArtifact,
    getSetting,
    listArtifacts,
    type ArtifactMeta,
    type CommandContext,
} from "@notshekhar/loop-core";
import { pathToFileURL } from "node:url";
import type { AppDeps } from "../deps";
import { openBrowser } from "../../open-browser";

type ArtifactHandlers = Pick<CommandContext, "manageArtifacts">;

/** A page's size, in the unit a page is actually measured in. */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `📊 Q3 Report — 12.4 KB`, or why it cannot be opened yet. */
function artifactLabel(a: ArtifactMeta): string {
    const icon = a.favicon ? `${a.favicon} ` : "";
    if (!a.written) return `${icon}${a.title} — not written yet`;
    return `${icon}${a.title} — ${formatBytes(a.size)}`;
}

const DELETE = "\x00delete";

export async function runArtifactsManager(deps: AppDeps): Promise<void> {
    const { history, tui, searchOnce, selectOnce } = deps;

    if (getSetting("artifacts") !== true) {
        history.addSystem(
            `artifacts are off — turn them on in /settings, then ask the agent for a report or write-up.`,
        );
        tui.requestRender();
        return;
    }

    while (true) {
        const artifacts = listArtifacts();
        if (artifacts.length === 0) {
            history.addSystem(
                `no artifacts yet — ask for a document, report or write-up and one will appear here.`,
            );
            tui.requestRender();
            return;
        }
        const items: SelectItem[] = artifacts.map((a) => ({
            value: a.id,
            label: artifactLabel(a),
            description: a.description ?? artifactFilePath(a),
        }));
        const pick = await searchOnce(items, "Artifacts (type to filter, Esc to close)");
        if (!pick) return;

        const artifact = artifacts.find((a) => a.id === pick.value);
        if (!artifact) continue;

        const path = artifactFilePath(artifact);
        if (!artifact.written) {
            // The agent reserved this one and never wrote it. Opening would
            // hand the browser a path that is not there.
            history.addSystem(`"${artifact.title}" has no content yet — the agent reserved it but never wrote it.`);
            tui.requestRender();
            continue;
        }

        const action = await selectOnce(
            [
                { value: "open", label: "Open in browser", description: path },
                { value: DELETE, label: "Delete", description: "remove this artifact from disk" },
            ],
            artifact.title,
        );
        if (!action) continue;

        if (action.value === DELETE) {
            history.addSystem(
                deleteArtifact(artifact.id) ? `deleted "${artifact.title}"` : `could not delete ${artifact.id}`,
            );
            tui.requestRender();
            continue;
        }

        const url = pathToFileURL(path).href;
        const opened = openBrowser(url);
        // Always print it: openBrowser only reports that it spawned something,
        // and on a headless box (SSH) nothing will have opened at all.
        history.addSystem(opened ? `opening "${artifact.title}" — ${url}` : `open it yourself: ${url}`);
        tui.requestRender();
        return;
    }
}

export function createArtifactHandlers(deps: AppDeps): ArtifactHandlers {
    return {
        manageArtifacts: () => runArtifactsManager(deps),
    };
}

/** Shown by `${PRODUCT_NAME} --help`-adjacent surfaces that count artifacts. */
export function artifactsStatusLabel(): string {
    if (getSetting("artifacts") !== true) return "off";
    const n = listArtifacts().length;
    return n === 0 ? "none yet" : `${n}`;
}
