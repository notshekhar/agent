/**
 * Configuring a custom provider from a remote client.
 *
 * `loop login` → "custom" is a wizard: name the gateway, say which vendor API
 * it speaks, give it a base URL, pick how it authenticates, then discover its
 * models (or type them in when the endpoint has no listing). None of that was
 * reachable over RPC — `auth.login` only stores a key against an id that
 * already exists — so the desktop app could see custom gateways the terminal
 * had created but could not create one, and the Providers page said as much in
 * prose ("configured with `loop login custom` in the terminal").
 *
 * The wizard's steps split cleanly into two RPCs, because only one of them
 * touches the network:
 *
 *     auth.custom.discover  → probe a DRAFT config for its model list
 *     auth.custom.save      → persist the finished config
 *
 * Discovery deliberately takes a draft rather than a saved name: the whole
 * point is to show the user what the endpoint offers *before* anything is
 * written, exactly as the terminal does. Saving is separate and idempotent, so
 * the same call also edits an existing gateway.
 *
 * The one step that cannot be a single call is `auth.kind: "oauth"` — a
 * browser sign-in is a conversation. It rides the existing `auth.flow.*`
 * machinery instead; see `startAuthFlow`'s `custom` input in auth-flows.ts.
 */
import {
    deleteCustomProvider,
    describeCustomAuth,
    getCustomProvider,
    hasCustomOAuthSession,
    listCustomProviders,
    normalizeCustomAuth,
    saveCustomProvider,
    setActiveProvider,
} from "../auth";
import { bustCatalogCache } from "../catalog";
import { fetchCustomProviderModels } from "../providers";
import type { CustomProviderAuth, CustomProviderConfig, CustomProviderSdk } from "../types";

/** The vendor API shapes a gateway may declare, in the order /login offers them. */
export const CUSTOM_PROVIDER_SDKS: readonly CustomProviderSdk[] = [
    "anthropic",
    "openai",
    "google",
    "openai-compatible",
];

/** Same rule the terminal wizard enforces, so both surfaces accept the same names. */
const NAME_PATTERN = /^[a-z0-9-]+$/;

export interface CustomProviderModelInput {
    readonly id: string;
    readonly name?: string;
    readonly contextWindow?: number;
    readonly maxOutput?: number;
    readonly cost?: {
        readonly input?: number;
        readonly output?: number;
        readonly cacheRead?: number;
        readonly cacheWrite?: number;
    };
}

/** A gateway as the client describes it — not yet saved, and possibly invalid. */
export interface CustomProviderDraft {
    readonly name: string;
    readonly sdk: CustomProviderSdk;
    readonly baseURL: string;
    readonly auth: CustomProviderAuth;
    readonly headers?: Record<string, string>;
    readonly models?: readonly CustomProviderModelInput[];
}

/**
 * A saved gateway, with its secrets removed.
 *
 * The credential never comes back: the client that stored it does not need it
 * echoed, and a settings page that renders one turns a credential store into a
 * credential display. `authDescription` carries what the UI actually wants to
 * say (the same line `/login` prints), and `hasStoredSecret` says whether the
 * form should offer "keep the existing key" rather than demanding a new one.
 *
 * `headers` is the exception, and deliberately so: they are structure, not
 * credential — a gateway is unroutable without its exact headers — so an edit
 * form that could not see them could only destroy them. A client rendering one
 * should treat the values as sensitive even though they travel.
 */
export interface CustomProviderSummary {
    /** The routing id — `custom:<name>` — so the client need not rebuild it. */
    readonly id: string;
    readonly name: string;
    readonly sdk: CustomProviderSdk;
    readonly baseURL: string;
    readonly authKind: CustomProviderAuth["kind"];
    readonly authDescription: string;
    /** True when the stored auth holds a secret this response is withholding. */
    readonly hasStoredSecret: boolean;
    /** `env` / `helper` are references, not secrets, so they round-trip. */
    readonly envVar?: string;
    readonly helperCommand?: string;
    /** True when an oauth gateway has a live session (no re-login needed). */
    readonly hasOAuthSession: boolean;
    readonly headers?: Record<string, string>;
    readonly models: readonly CustomProviderModelInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} required`);
    return value.trim();
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
    if (!isRecord(value)) return undefined;
    const headers: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value)) {
        const name = key.trim();
        if (name !== "" && typeof raw === "string") headers[name] = raw;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseModels(value: unknown): readonly CustomProviderModelInput[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const models: CustomProviderModelInput[] = [];
    for (const entry of value) {
        // A bare string is the common case from a UI's "type the model ids" field.
        if (typeof entry === "string") {
            const id = entry.trim();
            if (id !== "") models.push({ id });
            continue;
        }
        if (!isRecord(entry)) continue;
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        if (id === "") continue;
        const cost = isRecord(entry.cost)
            ? {
                  ...(optionalNumber(entry.cost.input) === undefined ? {} : { input: optionalNumber(entry.cost.input) }),
                  ...(optionalNumber(entry.cost.output) === undefined
                      ? {}
                      : { output: optionalNumber(entry.cost.output) }),
                  ...(optionalNumber(entry.cost.cacheRead) === undefined
                      ? {}
                      : { cacheRead: optionalNumber(entry.cost.cacheRead) }),
                  ...(optionalNumber(entry.cost.cacheWrite) === undefined
                      ? {}
                      : { cacheWrite: optionalNumber(entry.cost.cacheWrite) }),
              }
            : undefined;
        models.push({
            id,
            ...(typeof entry.name === "string" && entry.name.trim() !== "" ? { name: entry.name.trim() } : {}),
            ...(optionalNumber(entry.contextWindow) === undefined
                ? {}
                : { contextWindow: optionalNumber(entry.contextWindow) }),
            ...(optionalNumber(entry.maxOutput) === undefined ? {} : { maxOutput: optionalNumber(entry.maxOutput) }),
            ...(cost && Object.keys(cost).length > 0 ? { cost } : {}),
        });
    }
    return models;
}

/**
 * Read the `auth` block a client sent.
 *
 * `keep` is not one of core's kinds and never reaches the store: it means "the
 * user did not retype the secret, reuse what is saved". An edit form has no
 * other honest option, since the secret is deliberately never sent to it.
 */
export function parseCustomProviderAuth(value: unknown, existing?: CustomProviderConfig): CustomProviderAuth {
    if (!isRecord(value)) return existing ? normalizeCustomAuth(existing) : { kind: "none" };
    const kind = typeof value.kind === "string" ? value.kind : "";
    switch (kind) {
        case "keep": {
            if (!existing) throw new Error("no saved credential to keep");
            return normalizeCustomAuth(existing);
        }
        case "apikey":
            return { kind: "apikey", apiKey: requireString(value.apiKey, "apiKey") };
        case "bearer":
            return { kind: "bearer", token: requireString(value.token, "token") };
        case "env":
            return { kind: "env", var: requireString(value.var, "var") };
        case "helper": {
            const ttlMs = optionalNumber(value.ttlMs);
            return {
                kind: "helper",
                command: requireString(value.command, "command"),
                ...(ttlMs === undefined ? {} : { ttlMs }),
            };
        }
        case "oauth": {
            if (!isRecord(value.oauth)) return { kind: "oauth" };
            const options = value.oauth;
            const scopes = Array.isArray(options.scopes)
                ? options.scopes.filter((scope): scope is string => typeof scope === "string")
                : undefined;
            const oauth = {
                ...(typeof options.issuer === "string" && options.issuer.trim() !== ""
                    ? { issuer: options.issuer.trim() }
                    : {}),
                ...(typeof options.authorizationEndpoint === "string" && options.authorizationEndpoint.trim() !== ""
                    ? { authorizationEndpoint: options.authorizationEndpoint.trim() }
                    : {}),
                ...(typeof options.tokenEndpoint === "string" && options.tokenEndpoint.trim() !== ""
                    ? { tokenEndpoint: options.tokenEndpoint.trim() }
                    : {}),
                ...(typeof options.clientId === "string" && options.clientId.trim() !== ""
                    ? { clientId: options.clientId.trim() }
                    : {}),
                ...(typeof options.clientSecret === "string" && options.clientSecret !== ""
                    ? { clientSecret: options.clientSecret }
                    : {}),
                ...(scopes && scopes.length > 0 ? { scopes } : {}),
            };
            return Object.keys(oauth).length > 0 ? { kind: "oauth", oauth } : { kind: "oauth" };
        }
        case "none":
            return { kind: "none" };
        default:
            throw new Error(`unknown auth kind: ${kind || "(missing)"}`);
    }
}

/**
 * Validate and normalize a client's draft.
 *
 * The name is checked against the terminal's rule rather than merely trimmed,
 * because it becomes part of a model id (`custom:<name>/<model>`): a name with
 * a slash or a colon in it would produce ids that no longer parse, and the
 * failure would surface much later as an unroutable model.
 */
export function parseCustomProviderDraft(params: unknown): CustomProviderDraft {
    if (!isRecord(params)) throw new Error("custom provider config required");
    const name = requireString(params.name, "name").toLowerCase();
    if (!NAME_PATTERN.test(name)) throw new Error("name must be lowercase letters, digits, hyphens");
    const sdk = requireString(params.sdk, "sdk") as CustomProviderSdk;
    if (!CUSTOM_PROVIDER_SDKS.includes(sdk)) {
        throw new Error(`sdk must be one of: ${CUSTOM_PROVIDER_SDKS.join(", ")}`);
    }
    const baseURL = requireString(params.baseURL, "baseURL");
    const existing = getCustomProvider(name);
    const auth = parseCustomProviderAuth(params.auth, existing);
    const headers = parseHeaders(params.headers);
    const models = parseModels(params.models);
    return {
        name,
        sdk,
        baseURL,
        auth,
        ...(headers === undefined ? {} : { headers }),
        ...(models === undefined ? {} : { models }),
    };
}

/** The draft as core's own config shape, with the legacy flat key mirrored. */
export function draftToConfig(draft: CustomProviderDraft): CustomProviderConfig {
    return {
        name: draft.name,
        sdk: draft.sdk,
        baseURL: draft.baseURL,
        apiKey: draft.auth.kind === "apikey" ? draft.auth.apiKey : "",
        auth: draft.auth,
        ...(draft.headers === undefined ? {} : { headers: draft.headers }),
        ...(draft.models === undefined ? {} : { models: draft.models.map((model) => ({ ...model })) }),
    };
}

function toSummary(config: CustomProviderConfig): CustomProviderSummary {
    const auth = normalizeCustomAuth(config);
    return {
        id: `custom:${config.name}`,
        name: config.name,
        sdk: config.sdk,
        baseURL: config.baseURL,
        authKind: auth.kind,
        authDescription: describeCustomAuth(auth),
        hasStoredSecret: auth.kind === "apikey" || auth.kind === "bearer",
        ...(auth.kind === "env" ? { envVar: auth.var } : {}),
        ...(auth.kind === "helper" ? { helperCommand: auth.command } : {}),
        hasOAuthSession: auth.kind === "oauth" && hasCustomOAuthSession(config.name),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        models: (config.models ?? []).map((model) => ({ ...model })),
    };
}

/** `auth.custom.list` — every configured gateway, secrets withheld. */
export function listCustomProviderSummaries(): { providers: CustomProviderSummary[] } {
    return { providers: listCustomProviders().map(toSummary) };
}

/**
 * `auth.custom.discover` — ask a draft endpoint what models it serves.
 *
 * Returns `models: null` rather than throwing when the endpoint has no listing
 * (a 404, a timeout, an unparseable body). That is not an error the user needs
 * to fix: plenty of gateways simply don't expose `/models`, and the terminal
 * handles it by asking for ids by hand. The client needs to tell the two apart,
 * which a thrown error would not let it do.
 */
export async function discoverCustomProviderModels(params: unknown): Promise<{
    models: readonly CustomProviderModelInput[] | null;
}> {
    const draft = parseCustomProviderDraft(params);
    const discovered = await fetchCustomProviderModels(draftToConfig(draft));
    if (!discovered) return { models: null };
    return {
        models: discovered.map((model) => ({
            id: model.id,
            ...(model.name ? { name: model.name } : {}),
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
            ...(model.maxOutput ? { maxOutput: model.maxOutput } : {}),
        })),
    };
}

/**
 * `auth.custom.save` — persist a gateway and make its models routable.
 *
 * A gateway with no models is refused. It would save cleanly and then produce
 * an empty picker with nothing to explain it, because the catalog only invents
 * fallback models for a config whose list is absent — and by the time the user
 * sees the gap, the endpoint that could have been re-probed is three screens
 * back. The terminal wizard refuses for the same reason.
 */
export function saveCustomProviderConfig(params: unknown): {
    ok: true;
    id: string;
    name: string;
    models: number;
} {
    const draft = parseCustomProviderDraft(params);
    if (!draft.models || draft.models.length === 0) {
        throw new Error("at least one model id is required");
    }
    const config = draftToConfig(draft);
    saveCustomProvider(config);
    // The catalog is cached, so without this the gateway's models would not
    // appear in a picker until the process restarted.
    bustCatalogCache();
    return { ok: true, id: `custom:${draft.name}`, name: draft.name, models: draft.models.length };
}

/** `auth.custom.remove` — drop a gateway, its key, and any OAuth session. */
export function removeCustomProvider(params: unknown): { ok: true } {
    if (!isRecord(params)) throw new Error("name required");
    const raw = requireString(params.name, "name");
    // Accept either the bare name or the routing id, so a client holding a
    // provider id from `auth.providers` need not take it apart first.
    const name = raw.startsWith("custom:") ? raw.slice("custom:".length) : raw;
    if (!getCustomProvider(name)) throw new Error(`no custom provider named ${name}`);
    deleteCustomProvider(name);
    bustCatalogCache();
    return { ok: true };
}

/** `auth.custom.setActive` — the gateway new sessions default to. */
export function setActiveCustomProvider(params: unknown): { ok: true } {
    if (!isRecord(params)) throw new Error("name required");
    const raw = requireString(params.name, "name");
    const name = raw.startsWith("custom:") ? raw.slice("custom:".length) : raw;
    if (!getCustomProvider(name)) throw new Error(`no custom provider named ${name}`);
    setActiveProvider(`custom:${name}`);
    return { ok: true };
}
