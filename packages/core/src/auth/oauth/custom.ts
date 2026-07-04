/**
 * Config-driven OAuth for custom providers — the generic counterpart to the
 * vendor-specific flows in this directory. Works from nothing but a base URL:
 * endpoint discovery (RFC 8414, OIDC fallback), dynamic client registration
 * (RFC 7591), PKCE authorization-code with a loopback callback (plus paste
 * fallback for headless/remote sessions), and refresh that survives responses
 * omitting refresh_token (RFC 6749 §6) — dropping it there is what forces a
 * re-login on every launch.
 */
import type { CustomOAuthOptions, CustomProviderConfig, GenericOAuthCredentials } from "../../types";
import { startCallbackServer } from "../oauth-callback";
import { generatePKCE } from "./pkce";
import type { OAuthLoginCallbacks } from "./types";

const LOGIN_TIMEOUT_MS = 180_000;
const EXPIRY_SKEW_MS = 60_000;

export interface OAuthEndpoints {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
}

type FetchLike = typeof fetch;

/**
 * Discover the authorization server's endpoints from an issuer or the provider
 * base URL. Tries RFC 8414 (`oauth-authorization-server`) before OIDC
 * (`openid-configuration`), each at the path-aware location first, then the
 * origin root — gateways commonly mount the AS beside the API path.
 */
export async function discoverOAuthEndpoints(
    issuerOrBase: string,
    fetchImpl: FetchLike = fetch,
): Promise<OAuthEndpoints> {
    const u = new URL(issuerOrBase);
    const path = u.pathname.replace(/\/+$/, "");
    const candidates: string[] = [];
    for (const wellKnown of ["oauth-authorization-server", "openid-configuration"]) {
        if (path) {
            candidates.push(`${u.origin}/.well-known/${wellKnown}${path}`); // RFC 8414 path form
            candidates.push(`${u.origin}${path}/.well-known/${wellKnown}`);
        }
        candidates.push(`${u.origin}/.well-known/${wellKnown}`);
    }
    for (const url of [...new Set(candidates)]) {
        try {
            const res = await fetchImpl(url, {
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) continue;
            const meta = (await res.json()) as Record<string, unknown>;
            const authorization = String(meta.authorization_endpoint ?? "");
            const token = String(meta.token_endpoint ?? "");
            if (!authorization || !token) continue;
            return {
                authorization_endpoint: authorization,
                token_endpoint: token,
                ...(meta.registration_endpoint ? { registration_endpoint: String(meta.registration_endpoint) } : {}),
            };
        } catch {}
    }
    throw new Error(
        `could not discover OAuth endpoints from ${issuerOrBase} — ` +
            `the server exposes no .well-known metadata; set authorizationEndpoint/tokenEndpoint explicitly`,
    );
}

/** RFC 7591 anonymous dynamic client registration (public client, PKCE-only). */
async function registerClient(
    registrationEndpoint: string,
    redirectUri: string,
    scopes: string[] | undefined,
    fetchImpl: FetchLike,
): Promise<{ clientId: string; clientSecret?: string }> {
    const res = await fetchImpl(registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
            client_name: "loop",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            ...(scopes?.length ? { scope: scopes.join(" ") } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(
            `dynamic client registration failed (HTTP ${res.status}): ${text}\n` +
                `Register an OAuth app with the provider and set its clientId in the provider config instead.`,
        );
    }
    const data = JSON.parse(text) as Record<string, unknown>;
    const clientId = String(data.client_id ?? "");
    if (!clientId) throw new Error("dynamic client registration returned no client_id");
    return { clientId, ...(data.client_secret ? { clientSecret: String(data.client_secret) } : {}) };
}

/** Accepts a pasted redirect URL, `code=…&state=…` query string, or bare code. */
function parsePastedAuth(input: string): { code?: string; state?: string } {
    const v = input.trim();
    if (!v) return {};
    try {
        const u = new URL(v);
        return { code: u.searchParams.get("code") ?? undefined, state: u.searchParams.get("state") ?? undefined };
    } catch {}
    if (v.includes("code=")) {
        const p = new URLSearchParams(v);
        return { code: p.get("code") ?? undefined, state: p.get("state") ?? undefined };
    }
    return { code: v };
}

function credsFromTokenResponse(
    data: Record<string, unknown>,
    previous: Partial<GenericOAuthCredentials>,
): GenericOAuthCredentials {
    const access = String(data.access_token ?? "");
    if (!access) throw new Error("token response contained no access_token");
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in ?? 3600);
    return {
        ...previous,
        access,
        // A refresh response MAY omit refresh_token — keep the old one, or every
        // restart lands back on the browser login.
        refresh: String(data.refresh_token ?? previous.refresh ?? ""),
        expires: Date.now() + expiresIn * 1000 - EXPIRY_SKEW_MS,
    } as GenericOAuthCredentials;
}

async function postForm(
    url: string,
    body: Record<string, string>,
    fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
    const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Interactive browser login for a custom provider with `auth.kind === "oauth"`.
 * Returns credentials carrying everything refresh needs (token endpoint +
 * client), so later refreshes never re-discover or re-register.
 */
export async function customOAuthLogin(
    cfg: Pick<CustomProviderConfig, "name" | "baseURL" | "auth">,
    cb: OAuthLoginCallbacks,
    fetchImpl: FetchLike = fetch,
): Promise<GenericOAuthCredentials> {
    const opts: CustomOAuthOptions = cfg.auth?.kind === "oauth" ? (cfg.auth.oauth ?? {}) : {};

    let endpoints: OAuthEndpoints;
    if (opts.authorizationEndpoint && opts.tokenEndpoint) {
        endpoints = { authorization_endpoint: opts.authorizationEndpoint, token_endpoint: opts.tokenEndpoint };
    } else {
        cb.onProgress?.(`Discovering OAuth endpoints from ${opts.issuer ?? cfg.baseURL}…`);
        endpoints = await discoverOAuthEndpoints(opts.issuer ?? cfg.baseURL, fetchImpl);
    }

    const callback = await startCallbackServer();
    try {
        let clientId = opts.clientId;
        let clientSecret = opts.clientSecret;
        if (!clientId) {
            if (!endpoints.registration_endpoint) {
                throw new Error(
                    `${cfg.name}: server supports no dynamic client registration — ` +
                        `register an OAuth app there and set clientId in the provider config`,
                );
            }
            cb.onProgress?.("Registering OAuth client…");
            const reg = await registerClient(
                endpoints.registration_endpoint,
                callback.redirectUri,
                opts.scopes,
                fetchImpl,
            );
            clientId = reg.clientId;
            clientSecret = reg.clientSecret;
        }

        const { verifier, challenge } = await generatePKCE();
        const state = crypto.randomUUID();
        const authUrl = new URL(endpoints.authorization_endpoint);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", callback.redirectUri);
        authUrl.searchParams.set("code_challenge", challenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        authUrl.searchParams.set("state", state);
        if (opts.scopes?.length) authUrl.searchParams.set("scope", opts.scopes.join(" "));

        cb.onAuth({
            url: authUrl.toString(),
            instructions: `Sign in to ${cfg.name} in the browser. Callback listener: ${callback.redirectUri}`,
        });

        const result = await Promise.race([
            callback.waitForCode(LOGIN_TIMEOUT_MS),
            cb
                .onPrompt({
                    message: "Paste the redirect URL or authorization code (or wait for the browser):",
                    allowEmpty: true,
                })
                .then((input) => {
                    const p = parsePastedAuth(input);
                    return p.code ? { code: p.code, state: p.state } : null;
                }),
        ]);
        if (!result?.code) throw new Error("missing authorization code");
        if (result.state !== undefined && result.state !== state) throw new Error("OAuth state mismatch");

        const data = await postForm(
            endpoints.token_endpoint,
            {
                grant_type: "authorization_code",
                client_id: clientId,
                code: result.code,
                redirect_uri: callback.redirectUri,
                code_verifier: verifier,
                ...(clientSecret ? { client_secret: clientSecret } : {}),
            },
            fetchImpl,
        );
        return credsFromTokenResponse(data, {
            tokenEndpoint: endpoints.token_endpoint,
            clientId,
            ...(clientSecret ? { clientSecret } : {}),
        });
    } finally {
        callback.close();
    }
}

/** Refresh with the endpoint/client stored in the credentials at login time. */
export async function customOAuthRefresh(
    creds: GenericOAuthCredentials,
    fetchImpl: FetchLike = fetch,
): Promise<GenericOAuthCredentials> {
    if (!creds.refresh) throw new Error("no refresh token stored — sign in again via /login");
    const tokenEndpoint = String(creds.tokenEndpoint ?? "");
    const clientId = String(creds.clientId ?? "");
    if (!tokenEndpoint || !clientId) throw new Error("stored OAuth session is incomplete — sign in again via /login");
    const data = await postForm(
        tokenEndpoint,
        {
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: creds.refresh,
            ...(creds.clientSecret ? { client_secret: String(creds.clientSecret) } : {}),
        },
        fetchImpl,
    );
    return credsFromTokenResponse(data, creds);
}
