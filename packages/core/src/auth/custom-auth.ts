/**
 * Credential resolution for custom providers — the single seam between a
 * CustomProviderConfig's `auth` and the requests that need a credential
 * (model calls via the fetch wrapper, model discovery). Static kinds resolve
 * to a constant; `env` re-reads the environment each time; `helper` runs the
 * configured command and caches its stdout for a TTL (Claude Code apiKeyHelper
 * semantics: default 5 minutes, bypassed after a 401).
 */
import { execFile } from "node:child_process";
import type { CustomProviderAuth, CustomProviderConfig, CustomProviderSdk } from "../types";

/** The subset of CustomProviderConfig that credential resolution reads. */
export type CustomAuthConfig = Pick<CustomProviderConfig, "name" | "sdk" | "apiKey" | "auth" | "headers">;

/** Effective auth of a config: explicit `auth`, or the legacy flat apiKey. */
export function normalizeCustomAuth(cfg: Pick<CustomProviderConfig, "apiKey" | "auth">): CustomProviderAuth {
    if (cfg.auth) return cfg.auth;
    return cfg.apiKey ? { kind: "apikey", apiKey: cfg.apiKey } : { kind: "none" };
}

/** One-line label for /login listings and status output. */
export function describeCustomAuth(auth: CustomProviderAuth): string {
    switch (auth.kind) {
        case "apikey":
            return "api key";
        case "bearer":
            return "bearer token";
        case "env":
            return `env $${auth.var}`;
        case "helper":
            return `helper: ${auth.command}`;
        case "none":
            return "no credential";
    }
}

/**
 * Header that carries an API-key credential for each vendor API shape. Bearer
 * auth doesn't use this — it always sends `Authorization: Bearer` (that's what
 * distinguishes the kind).
 */
export function authHeaderForSdk(sdk: CustomProviderSdk, key: string): [name: string, value: string] {
    switch (sdk) {
        case "anthropic":
            return ["x-api-key", key];
        case "google":
            return ["x-goog-api-key", key];
        default:
            return ["authorization", `Bearer ${key}`];
    }
}

const HELPER_TTL_DEFAULT_MS = 5 * 60 * 1000;
const HELPER_TIMEOUT_MS = 10_000;
const helperCache = new Map<string, { key: string; at: number }>();

/** Test hook / logout hygiene: drop cached helper output. */
export function clearHelperCache(name?: string): void {
    if (name) helperCache.delete(name);
    else helperCache.clear();
}

function runHelper(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // Through the shell, like Claude Code's apiKeyHelper — helpers are
        // things like `op read op://vault/key` or a token-minting script.
        execFile(command, { shell: true, timeout: HELPER_TIMEOUT_MS }, (err, stdout) => {
            if (err) {
                reject(new Error(`auth helper failed: ${err.message}`));
                return;
            }
            const key = stdout.trim();
            if (!key) {
                reject(new Error(`auth helper printed nothing: ${command}`));
                return;
            }
            resolve(key);
        });
    });
}

/**
 * Resolve the credential string for a custom provider, or null when the config
 * carries none (kind `none`, or an empty stored key). Throws with an actionable
 * message when an env var is missing or a helper fails. `force` bypasses the
 * helper cache — used by the fetch wrapper after a 401.
 */
export async function resolveCustomCredential(
    cfg: Pick<CustomProviderConfig, "name" | "apiKey" | "auth">,
    opts: { force?: boolean } = {},
): Promise<string | null> {
    const auth = normalizeCustomAuth(cfg);
    switch (auth.kind) {
        case "apikey":
            return auth.apiKey || null;
        case "bearer":
            return auth.token || null;
        case "env": {
            const value = process.env[auth.var];
            if (!value) {
                throw new Error(`custom provider "${cfg.name}": environment variable ${auth.var} is not set`);
            }
            return value;
        }
        case "helper": {
            const ttl = auth.ttlMs ?? HELPER_TTL_DEFAULT_MS;
            const hit = helperCache.get(cfg.name);
            if (!opts.force && hit && Date.now() - hit.at < ttl) return hit.key;
            const key = await runHelper(auth.command);
            helperCache.set(cfg.name, { key, at: Date.now() });
            return key;
        }
        case "none":
            return null;
    }
}

/** Where the resolved credential goes for this auth kind. */
function credentialHeader(auth: CustomProviderAuth, sdk: CustomProviderSdk, cred: string): [string, string] {
    return auth.kind === "bearer" ? ["authorization", `Bearer ${cred}`] : authHeaderForSdk(sdk, cred);
}

/** True when re-resolving after a 401 can yield a different credential. */
function isDynamicAuth(auth: CustomProviderAuth): boolean {
    return auth.kind === "helper";
}

/** Bare fetch shape — no Bun `preconnect` property; providers/index.ts wraps
 * the returned handler with its preconnect-preserving adapter. */
export type PlainFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

/**
 * Fetch wrapper for a custom provider: applies configured extra headers,
 * injects the resolved credential for non-apikey kinds (the plain apikey kind
 * stays on the SDK's own header handling, unchanged from before `auth`
 * existed), and for dynamic credentials refreshes once and retries on 401 —
 * the same shape as the xai OAuth fetch. Returns undefined when there is
 * nothing to do so callers can keep the SDK's default fetch.
 */
export function createCustomAuthFetch(cfg: CustomAuthConfig, baseFetch: PlainFetch = fetch): PlainFetch | undefined {
    const auth = normalizeCustomAuth(cfg);
    const extraHeaders = Object.entries(cfg.headers ?? {});
    const injects = auth.kind !== "apikey" && auth.kind !== "none";
    if (!injects && extraHeaders.length === 0) return undefined;

    // Explicit configured headers outrank the resolved credential (matching
    // the pre-`auth` behavior where extra headers were applied last).
    const userSet = new Set(extraHeaders.map(([k]) => k.toLowerCase()));

    return async (input, init) => {
        const headers = new Headers(init?.headers);
        for (const [k, v] of extraHeaders) headers.set(k, v);
        const inject = async (force: boolean) => {
            if (!injects) return;
            const cred = await resolveCustomCredential(cfg, { force });
            if (!cred) return;
            const [name, value] = credentialHeader(auth, cfg.sdk, cred);
            if (!userSet.has(name)) headers.set(name, value);
        };
        await inject(false);
        const res = await baseFetch(input, { ...(init as RequestInit), headers });
        if (res.status === 401 && isDynamicAuth(auth)) {
            try {
                await inject(true);
            } catch {
                return res;
            }
            return baseFetch(input, { ...(init as RequestInit), headers });
        }
        return res;
    };
}

/**
 * Credential headers for a one-shot request made outside the SDKs (model
 * discovery). Same placement rules as the fetch wrapper, but returned as a
 * plain object; resolution failures surface as an empty object so discovery
 * can degrade to its manual-model-ids fallback.
 */
export async function customAuthHeaders(cfg: CustomAuthConfig): Promise<Record<string, string>> {
    const auth = normalizeCustomAuth(cfg);
    try {
        const cred = await resolveCustomCredential(cfg);
        if (!cred) return {};
        const [name, value] = credentialHeader(auth, cfg.sdk, cred);
        return { [name]: value };
    } catch {
        return {};
    }
}
