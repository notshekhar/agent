import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GenericOAuthCredentials } from "../src/types";

// In-memory creds store so nothing touches the real ~/.loop/auth.json.
const credsMem = new Map<string, GenericOAuthCredentials>();
mock.module("../src/auth/custom-oauth-store", () => ({
    getCustomOAuthCreds: (name: string) => credsMem.get(name),
    saveCustomOAuthCreds: (name: string, creds: GenericOAuthCredentials) => void credsMem.set(name, creds),
    clearCustomOAuthCreds: (name: string) => void credsMem.delete(name),
}));

const { discoverOAuthEndpoints, customOAuthLogin, customOAuthRefresh } = await import("../src/auth/oauth/custom");
const { resolveCustomCredential, createCustomAuthFetch } = await import("../src/auth/custom-auth");

type FetchLike = typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fetch stub: routes by URL substring, records requests. */
function fakeFetch(routes: Array<{ match: string; respond: (req: Request) => Response | Promise<Response> }>) {
    const calls: Request[] = [];
    const f = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const req = new Request(input, init);
        calls.push(req);
        const route = routes.find((r) => req.url.includes(r.match));
        if (!route) return new Response("not found", { status: 404 });
        return route.respond(req);
    }) as FetchLike;
    return { fetch: f, calls };
}

beforeEach(() => credsMem.clear());

describe("discoverOAuthEndpoints", () => {
    test("uses RFC 8414 metadata when present", async () => {
        const { fetch } = fakeFetch([
            {
                match: "/.well-known/oauth-authorization-server",
                respond: () =>
                    jsonResponse(200, {
                        authorization_endpoint: "https://gw.example/authorize",
                        token_endpoint: "https://gw.example/token",
                        registration_endpoint: "https://gw.example/register",
                    }),
            },
        ]);
        const ep = await discoverOAuthEndpoints("https://gw.example/anthropic", fetch);
        expect(ep.authorization_endpoint).toBe("https://gw.example/authorize");
        expect(ep.registration_endpoint).toBe("https://gw.example/register");
    });

    test("falls back to openid-configuration", async () => {
        const { fetch } = fakeFetch([
            {
                match: "openid-configuration",
                respond: () =>
                    jsonResponse(200, {
                        authorization_endpoint: "https://sso.example/auth",
                        token_endpoint: "https://sso.example/token",
                    }),
            },
        ]);
        const ep = await discoverOAuthEndpoints("https://gw.example", fetch);
        expect(ep.token_endpoint).toBe("https://sso.example/token");
    });

    test("throws an actionable error when nothing is discoverable", async () => {
        const { fetch } = fakeFetch([]);
        expect(discoverOAuthEndpoints("https://gw.example", fetch)).rejects.toThrow(/well-known/);
    });
});

describe("customOAuthRefresh", () => {
    const baseCreds: GenericOAuthCredentials = {
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
        tokenEndpoint: "https://gw.example/token",
        clientId: "cid",
    };

    test("keeps the previous refresh_token when the response omits it", async () => {
        const { fetch } = fakeFetch([
            { match: "/token", respond: () => jsonResponse(200, { access_token: "new-access", expires_in: 3600 }) },
        ]);
        const fresh = await customOAuthRefresh(baseCreds, fetch);
        expect(fresh.access).toBe("new-access");
        expect(fresh.refresh).toBe("old-refresh");
        expect(fresh.expires).toBeGreaterThan(Date.now());
    });

    test("adopts a rotated refresh_token when the response includes one", async () => {
        const { fetch } = fakeFetch([
            {
                match: "/token",
                respond: () => jsonResponse(200, { access_token: "a2", refresh_token: "r2", expires_in: 60 }),
            },
        ]);
        const fresh = await customOAuthRefresh(baseCreds, fetch);
        expect(fresh.refresh).toBe("r2");
    });

    test("fails with a re-login hint when the session has no refresh token", async () => {
        const { fetch } = fakeFetch([]);
        expect(customOAuthRefresh({ ...baseCreds, refresh: "" }, fetch)).rejects.toThrow(/\/login/);
    });
});

describe("resolveCustomCredential oauth kind", () => {
    const cfg = { name: "gw", apiKey: "", auth: { kind: "oauth" } as const };

    test("returns the stored access token while valid", async () => {
        credsMem.set("gw", {
            access: "live",
            refresh: "r",
            expires: Date.now() + 60_000,
            tokenEndpoint: "https://gw.example/token",
            clientId: "cid",
        });
        expect(await resolveCustomCredential(cfg)).toBe("live");
    });

    test("refreshes and persists when expired", async () => {
        credsMem.set("gw", {
            access: "stale",
            refresh: "r",
            expires: Date.now() - 1,
            tokenEndpoint: "https://gw.example/token",
            clientId: "cid",
        });
        const { fetch } = fakeFetch([
            { match: "/token", respond: () => jsonResponse(200, { access_token: "fresh", expires_in: 3600 }) },
        ]);
        const realFetch = globalThis.fetch;
        globalThis.fetch = fetch as typeof globalThis.fetch;
        try {
            expect(await resolveCustomCredential(cfg)).toBe("fresh");
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(credsMem.get("gw")?.access).toBe("fresh");
        expect(credsMem.get("gw")?.refresh).toBe("r");
    });

    test("throws a sign-in hint when no session is stored", async () => {
        expect(resolveCustomCredential(cfg)).rejects.toThrow(/not signed in/);
    });
});

describe("createCustomAuthFetch oauth kind", () => {
    test("sends Bearer regardless of sdk and force-refreshes once on 401", async () => {
        credsMem.set("gw", {
            access: "t1",
            refresh: "r",
            expires: Date.now() + 60_000,
            tokenEndpoint: "https://gw.example/token",
            clientId: "cid",
        });
        const seen: string[] = [];
        let first = true;
        const base = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const req = new Request(input, init);
            if (req.url.includes("/token")) return jsonResponse(200, { access_token: "t2", expires_in: 60 });
            seen.push(req.headers.get("authorization") ?? "");
            if (first) {
                first = false;
                return new Response("unauthorized", { status: 401 });
            }
            return new Response("ok", { status: 200 });
        }) as FetchLike;
        // Route the refresh POST through the same stub.
        const realFetch = globalThis.fetch;
        globalThis.fetch = base as typeof globalThis.fetch;
        try {
            const wrapped = createCustomAuthFetch(
                { name: "gw", sdk: "anthropic", apiKey: "", auth: { kind: "oauth" } },
                base,
            );
            const res = await wrapped!("https://gw.example/v1/messages");
            expect(res.status).toBe(200);
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
    });
});

describe("customOAuthLogin", () => {
    test("discovers, registers, opens browser, exchanges code via loopback", async () => {
        const { fetch, calls } = fakeFetch([
            {
                match: "/.well-known/oauth-authorization-server",
                respond: () =>
                    jsonResponse(200, {
                        authorization_endpoint: "https://gw.example/authorize",
                        token_endpoint: "https://gw.example/token",
                        registration_endpoint: "https://gw.example/register",
                    }),
            },
            { match: "/register", respond: () => jsonResponse(201, { client_id: "dyn-client" }) },
            {
                match: "/token",
                respond: () => jsonResponse(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }),
            },
        ]);

        const creds = await customOAuthLogin(
            { name: "gw", baseURL: "https://gw.example/anthropic", auth: { kind: "oauth" } },
            {
                onAuth: ({ url }) => {
                    // Simulate the browser: hit the loopback redirect with code+state.
                    const auth = new URL(url);
                    expect(auth.origin).toBe("https://gw.example");
                    expect(auth.searchParams.get("client_id")).toBe("dyn-client");
                    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
                    const redirect = new URL(auth.searchParams.get("redirect_uri")!);
                    redirect.searchParams.set("code", "the-code");
                    redirect.searchParams.set("state", auth.searchParams.get("state")!);
                    void globalThis.fetch(redirect.toString());
                },
                onPrompt: () => new Promise<never>(() => {}),
            },
            fetch,
        );

        expect(creds.access).toBe("at");
        expect(creds.refresh).toBe("rt");
        expect(creds.clientId).toBe("dyn-client");
        expect(creds.tokenEndpoint).toBe("https://gw.example/token");

        const tokenCall = calls.find((c) => c.url.includes("/token"))!;
        const body = new URLSearchParams(await tokenCall.text());
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("the-code");
        expect(body.get("code_verifier")).toBeTruthy();
    });

    test("skips discovery when explicit endpoints are configured", async () => {
        const { fetch, calls } = fakeFetch([
            { match: "/token", respond: () => jsonResponse(200, { access_token: "at", expires_in: 60 }) },
        ]);
        const creds = await customOAuthLogin(
            {
                name: "gw",
                baseURL: "https://gw.example",
                auth: {
                    kind: "oauth",
                    oauth: {
                        authorizationEndpoint: "https://sso.example/auth",
                        tokenEndpoint: "https://gw.example/token",
                        clientId: "preset",
                        scopes: ["api", "offline_access"],
                    },
                },
            },
            {
                onAuth: ({ url }) => {
                    const auth = new URL(url);
                    expect(auth.searchParams.get("scope")).toBe("api offline_access");
                    const redirect = new URL(auth.searchParams.get("redirect_uri")!);
                    redirect.searchParams.set("code", "c");
                    redirect.searchParams.set("state", auth.searchParams.get("state")!);
                    void globalThis.fetch(redirect.toString());
                },
                onPrompt: () => new Promise<never>(() => {}),
            },
            fetch,
        );
        expect(creds.access).toBe("at");
        expect(calls.every((c) => !c.url.includes(".well-known"))).toBe(true);
    });

    test("fails cleanly when no clientId and no registration endpoint", async () => {
        const { fetch } = fakeFetch([
            {
                match: "openid-configuration",
                respond: () =>
                    jsonResponse(200, {
                        authorization_endpoint: "https://sso.example/auth",
                        token_endpoint: "https://sso.example/token",
                    }),
            },
        ]);
        expect(
            customOAuthLogin(
                { name: "gw", baseURL: "https://gw.example", auth: { kind: "oauth" } },
                { onAuth: () => {}, onPrompt: () => new Promise<never>(() => {}) },
                fetch,
            ),
        ).rejects.toThrow(/clientId/);
    });
});
