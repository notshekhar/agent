/**
 * The `ServerConfig` the UI connects against, built from loop.
 *
 * Upstream's server sent this down the socket. Here it is assembled from
 * loop's own `catalog.list` + `auth.status`, so **the provider and model list
 * in the picker is loop's**, not a UI-side default.
 *
 * Everything is produced by DECODING a minimal object rather than by writing
 * out a literal: the schema defaults every field it can, so a config built
 * this way cannot drift from the contract as upstream adds fields.
 */
import { ServerConfig, type ServerProvider } from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { APP_VERSION } from "../../branding.ts";
import { toInstanceId } from "./ids.ts";
import { loopCall } from "../transport.ts";

/**
 * Shapes loop's RPC actually returns; measured against a live `loop serve`,
 * not guessed from the contract. Two of these are easy to get wrong:
 * `catalog.list` is a FLAT list of models (grouped here by `provider`), and
 * `auth.status` is arrays of provider ids, not objects.
 */
interface LoopCatalogModel {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly reasoning?: boolean;
  readonly available?: boolean;
  readonly modalities?: readonly string[];
}
export interface LoopServerInfo {
  readonly protocol?: string;
  readonly methods?: readonly string[];
  readonly events?: readonly string[];
  readonly defaults?: {
    /** loop's configured `defaultModel`, or null when unset. */
    readonly model?: string | null;
    /** The folder the `loop rpc` process was started in. */
    readonly cwd?: string;
  };
}
interface LoopAuthStatus {
  /** Every provider loop knows about. */
  readonly providers?: readonly string[];
  /** The subset that has usable credentials. */
  readonly authorized?: readonly string[];
  /** The one currently selected. */
  readonly active?: string | null;
}

const decodeConfig = Schema.decodeUnknownEffect(ServerConfig);

// The server version is reported as the app's own — see APP_VERSION's import
// above. Anything else trips the client/server skew banner, which is
// meaningless when the UI and the agent ship as one artifact, and it must come
// from the same constant the client compares against or the banner nags about
// a version nobody can install.

function platformOs(): "darwin" | "linux" | "windows" | "unknown" {
  const ua = globalThis.navigator?.userAgent ?? "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "darwin";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}

function platformArch(): "arm64" | "x64" {
  const ua = globalThis.navigator?.userAgent ?? "";
  return /arm|aarch64/i.test(ua) ? "arm64" : "x64";
}

/**
 * loop's providers, in the contract's shape.
 *
 * `ProviderInstanceId` and `ProviderDriverKind` are open branded slugs whose
 * pattern allows `:`, so loop's ids — including custom ones like
 * `custom:pronto-gpt` — are legal as-is and need no mapping table.
 */
function toProviders(
  catalog: readonly LoopCatalogModel[],
  auth: LoopAuthStatus,
  configured: string | null | undefined,
  checkedAt: string,
): readonly unknown[] {
  const byProvider = new Map<string, LoopCatalogModel[]>();
  for (const model of catalog) {
    const bucket = byProvider.get(model.provider);
    if (bucket) bucket.push(model);
    else byProvider.set(model.provider, [model]);
  }
  // A provider loop has credentials for but no catalog entry still belongs in
  // the list — the user can authenticate it and pick a custom model.
  for (const id of auth.providers ?? []) if (!byProvider.has(id)) byProvider.set(id, []);

  const authorized = new Set(auth.authorized ?? []);
  return [...byProvider].map(([id, models]) => ({
    instanceId: toInstanceId(id),
    driver: toInstanceId(id),
    displayName: id,
    enabled: true,
    installed: true,
    version: null,
    status: authorized.has(id) ? "ready" : "disabled",
    auth: { status: authorized.has(id) ? "authenticated" : "unauthenticated" },
    checkedAt,
    models: models.map((model) => ({
      slug: model.id,
      name: model.name ?? model.id,
      isCustom: false,
      ...(model.id === configured ? { isDefault: true } : {}),
      capabilities: {
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxOutput === undefined ? {} : { maxOutputTokens: model.maxOutput }),
        reasoning: model.reasoning === true,
      },
    })),
  })) as readonly unknown[];
}

/**
 * loop's default model, for the composer's picker.
 *
 * `ServerSettings.textGenerationModelSelection` defaults to upstream's own
 * choice (codex / gpt-5.6-luna) when left unset. Leaving it would put another
 * agent's model in loop's composer, so the selection is always pinned to
 * something loop actually offers: the first model of the first authenticated
 * provider, falling back to the first model in the catalog.
 */
function defaultModelSelection(
  catalog: readonly LoopCatalogModel[],
  auth: LoopAuthStatus,
  configured: string | null | undefined,
): { instanceId: string; model: string } | undefined {
  // loop's own `defaultModel` setting wins whenever the catalog can place it.
  const exact = configured ? catalog.find((model) => model.id === configured) : undefined;
  if (exact) return { instanceId: toInstanceId(exact.provider), model: exact.id };

  const authorized = new Set(auth.authorized ?? []);
  const active = auth.active ?? undefined;
  const pick =
    (active ? catalog.find((m) => m.provider === active && m.available !== false) : undefined) ??
    catalog.find((m) => authorized.has(m.provider) && m.available !== false) ??
    catalog[0];
  if (!pick) return undefined;
  return { instanceId: toInstanceId(pick.provider), model: pick.id };
}

export interface BuildServerConfigOptions {
  /** The folder this environment is anchored to. */
  readonly cwd: string;
  readonly environmentId: string;
  readonly label: string;
}

export const buildServerConfig = Effect.fnUntraced(function* (options: BuildServerConfigOptions) {
  const [catalog, auth, info] = yield* Effect.promise(() =>
    Promise.all([
      loopCall<readonly LoopCatalogModel[]>("catalog.list", {}, options.cwd).catch(
        () => [] as readonly LoopCatalogModel[],
      ),
      loopCall<LoopAuthStatus>("auth.status", {}, options.cwd).catch(() => ({}) as LoopAuthStatus),
      loopCall<LoopServerInfo>("server.info", {}, options.cwd).catch(() => ({}) as LoopServerInfo),
    ]),
  );

  const selection = defaultModelSelection(catalog, auth, info.defaults?.model);
  // The folder loop is actually running in beats whatever the shell guessed.
  const cwd = info.defaults?.cwd ?? options.cwd;

  return yield* decodeConfig({
    environment: {
      environmentId: options.environmentId,
      label: options.label,
      platform: { os: platformOs(), arch: platformArch() },
      serverVersion: APP_VERSION,
      capabilities: {
        repositoryIdentity: false,
        connectionProbe: true,
      },
    },
    auth: {
      // loop's serve token is checked at the socket, and the desktop shell
      // talks to a local process it spawned itself. By the time any RPC runs
      // the connection is already trusted.
      policy: "desktop-managed-local",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "loop-session",
    },
    cwd,
    keybindingsConfigPath: `${cwd}/.loop/keybindings.json`,
    keybindings: [],
    issues: [],
    providers: toProviders(catalog, auth, info.defaults?.model, new Date().toISOString()),
    availableEditors: [],
    observability: {
      logsDirectoryPath: `${cwd}/.loop/logs`,
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      // loop streams every turn; upstream's default of `false` would make the
      // assistant appear only once a turn had finished.
      enableAssistantStreaming: true,
      // loop owns its own update story, so the UI must not poll for provider
      // binary updates it cannot install.
      enableProviderUpdateChecks: false,
      ...(selection === undefined ? {} : { textGenerationModelSelection: selection }),
    },
  });
});

export type { ServerProvider };
