/**
 * Builds + shows the startup welcome banner and keeps a single live instance so
 * a late-arriving update notice lands on the banner currently on screen.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import { DEFAULT_AGENT_NAME } from "@notshekhar/loop-core";
import { WelcomeBanner } from "./components/welcome-banner";
import type { ChatHistory } from "./components/chat-history";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";

let activeBanner: WelcomeBanner | null = null;
// Remembered so a banner recreated on /new or /clear keeps the notice, and so a
// notice that arrives (network) before the banner exists still lands on it.
let updateNotice: string | undefined;

/**
 * Set the "update available" line shown under the welcome masthead. Routed here
 * (instead of appended to chat history) so it sits with the banner at the top
 * rather than floating below the conversation when the async check resolves.
 */
export function setWelcomeUpdateNotice(text: string): void {
    updateNotice = text;
    activeBanner?.setUpdateNotice(text);
}

function username(): string {
    try {
        return os.userInfo().username || process.env.USER || process.env.USERNAME || "there";
    } catch {
        return process.env.USER || process.env.USERNAME || "there";
    }
}

function shortenPath(p: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Current branch name, or null outside a repo / on a detached HEAD. Sync and
 * short-timeout on purpose: it runs once per banner during startup, and a
 * missing or slow git must never delay the first paint.
 */
function gitBranch(cwd: string): string | null {
    try {
        const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd,
            encoding: "utf8",
            timeout: 500,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return out && out !== "HEAD" ? out : null;
    } catch {
        return null;
    }
}

/** Render the masthead into chat history; replaces any prior live banner. */
export function showWelcomeBanner(history: ChatHistory, state: AppState, deps: AppDeps): void {
    const banner = new WelcomeBanner(deps.tui, {
        name: username(),
        model: state.modelId,
        session: state.session?.id ?? "unsaved",
        agent: state.agent !== DEFAULT_AGENT_NAME ? state.agent : null,
        branch: gitBranch(state.cwd),
        cwd: shortenPath(state.cwd),
        version: deps.version,
    });
    activeBanner = banner;
    if (updateNotice) banner.setUpdateNotice(updateNotice);
    history.addChild(banner);
    deps.tui.requestRender();
}
