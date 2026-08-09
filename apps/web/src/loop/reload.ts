/**
 * `/reload` — loop's own, from the app.
 *
 * The terminal has had this since forever and the app had no equivalent, which
 * is the whole bug: `settings.json`, an agent file, an MCP entry or a skill
 * edited on disk stayed invisible to a running app. loop's settings are served
 * from an in-memory cache and its model catalog is cached for the process, so
 * "restart the app" was the only way to pick an edit up.
 *
 * Two halves have to happen, in order:
 *
 *   1. loop re-reads its own config (`config.reload` — settings, commands,
 *      agents, catalog, MCP). Without this the app would re-fetch and be
 *      handed the same cached answers.
 *   2. The app re-reads loop. Its `ServerConfig` — the provider and model list
 *      behind every picker — is polled on a 30s tick, so a reload that only
 *      did (1) would look like it did nothing for half a minute.
 *
 * The bus in the middle is what makes (2) immediate; see `subscribeServerConfig`
 * in `handlers/index.ts`, which merges it into its own poll.
 */
import { loopCall } from "./transport.ts";

/** What loop re-read, for the confirmation line. */
export interface ReloadSummary {
  readonly models: number;
  readonly availableModels: number;
  readonly commands: number;
  readonly agents: number;
  readonly providers: number;
}

const CONFIG_RELOADED_EVENT = "loop:config-reloaded";

/** Tell the config subscription to re-read loop now rather than on its next tick. */
export function announceConfigReloaded(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CONFIG_RELOADED_EVENT));
}

/** Subscribe to reloads. Returns an unsubscribe. */
export function onConfigReloaded(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(CONFIG_RELOADED_EVENT, handler);
  return () => window.removeEventListener(CONFIG_RELOADED_EVENT, handler);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Reload loop's config, then the app's view of it.
 *
 * THROWS, because it is an action a user asked for: an older loop with no
 * `config.reload` has to say so rather than flash a success toast over a
 * config that did not move. The readers in `insights.ts` swallow their errors
 * for the opposite reason — a panel that cannot load is a fair report.
 */
export async function reloadLoopConfig(cwd?: string): Promise<ReloadSummary> {
  const result = await loopCall<unknown>("config.reload", {}, cwd);
  announceConfigReloaded();
  const summary = isRecord(result) ? result : {};
  return {
    models: count(summary.models),
    availableModels: count(summary.availableModels),
    commands: count(summary.commands),
    agents: count(summary.agents),
    providers: count(summary.providers),
  };
}
