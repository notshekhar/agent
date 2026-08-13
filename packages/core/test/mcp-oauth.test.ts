import { describe, expect, test } from "bun:test";
import { clearMcpAuth, isOAuthServer, McpOAuthProvider, oauthClientOptions } from "../src/mcp/oauth";
import type { HttpServerConfig } from "../src/mcp/config";

const REDIRECT = "http://127.0.0.1:8976/callback";

describe("MCP OAuth: pre-registered client support", () => {
    test("a configured clientId is handed to the SDK, skipping dynamic registration", () => {
        const p = new McpOAuthProvider("test-figma", REDIRECT, undefined, {
            clientId: "abc123",
            clientSecret: "shh",
            scopes: ["mcp:connect"],
        });
        expect(p.clientInformation()).toEqual({ client_id: "abc123", client_secret: "shh" });
    });

    test("a confidential client (secret) negotiates client_secret_post + requested scope", () => {
        const p = new McpOAuthProvider("test-figma", REDIRECT, undefined, {
            clientId: "abc123",
            clientSecret: "shh",
            scopes: ["mcp:connect", "files:read"],
        });
        expect(p.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
        expect(p.clientMetadata.scope).toBe("mcp:connect files:read");
    });

    test("a public client (no secret) stays PKCE-only (token_endpoint_auth_method=none)", () => {
        const p = new McpOAuthProvider("test-pub-" + Date.now(), REDIRECT);
        expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
        expect(p.clientMetadata.scope).toBeUndefined();
        // No configured client and nothing stored → undefined, so the SDK runs
        // dynamic registration as before.
        expect(p.clientInformation()).toBeUndefined();
    });

    test("oauthClientOptions resolves ${env:VAR} secrets from the environment", () => {
        process.env.FIGMA_TEST_SECRET = "from-env";
        const cfg: HttpServerConfig = {
            type: "http",
            url: "https://mcp.figma.com/mcp",
            auth: "oauth",
            clientId: "client-x",
            clientSecret: "${env:FIGMA_TEST_SECRET}",
            scopes: ["mcp:connect"],
        };
        const opts = oauthClientOptions(cfg);
        expect(opts.clientId).toBe("client-x");
        expect(opts.clientSecret).toBe("from-env");
        expect(opts.scopes).toEqual(["mcp:connect"]);
        delete process.env.FIGMA_TEST_SECRET;
    });
});

/**
 * The authorization server has to survive the gap between the two `auth()`
 * passes of a login: the first resolves it and opens the browser, the second
 * comes back with a code and must prove it is exchanging against the same
 * server. The SDK's default place to keep it is on the stored client
 * information — which is a trap for a pre-registered client, because that
 * object is rebuilt from config on every read and never carries anything the
 * SDK wrote to it.
 */
describe("MCP OAuth: authorization server metadata", () => {
    const AS = { authorizationServerUrl: "https://slack.com/oauth", tokenEndpoint: "https://slack.com/api/oauth.v2.access" };

    test("round-trips through the store", () => {
        const server = "test-as-" + Date.now();
        const p = new McpOAuthProvider(server, REDIRECT);
        try {
            expect(p.authorizationServerInformation()).toBeUndefined();
            p.saveAuthorizationServerInformation(AS);
            expect(p.authorizationServerInformation()).toEqual(AS);
        } finally {
            clearMcpAuth(server);
        }
    });

    /**
     * The actual bug. Slack, Figma and friends forbid dynamic registration, so
     * they are configured with a `clientId` — and `clientInformation()` then
     * returns a fresh literal every time. Anything the SDK stamped onto it
     * before the redirect was gone by the exchange, which failed with "Stored
     * OAuth authorization server metadata is required when exchanging an
     * authorization code". Keeping the metadata separate is what fixes it.
     */
    test("survives a configured clientId, which rebuilds client information every read", () => {
        const server = "test-as-configured-" + Date.now();
        const p = new McpOAuthProvider(server, REDIRECT, undefined, { clientId: "slack-app", clientSecret: "shh" });
        try {
            p.saveAuthorizationServerInformation(AS);
            // Unchanged: still the configured client, carrying no metadata...
            expect(p.clientInformation()).toEqual({ client_id: "slack-app", client_secret: "shh" });
            // ...and the metadata is readable anyway, which is the whole point.
            expect(p.authorizationServerInformation()).toEqual(AS);
        } finally {
            clearMcpAuth(server);
        }
    });

    test("saving it does not disturb the rest of the session", () => {
        const server = "test-as-mixed-" + Date.now();
        const p = new McpOAuthProvider(server, REDIRECT);
        try {
            p.saveCodeVerifier("verifier-1");
            p.saveState("state-1");
            p.saveAuthorizationServerInformation(AS);
            expect(p.codeVerifier()).toBe("verifier-1");
            expect(p.storedState()).toBe("state-1");
            expect(p.authorizationServerInformation()).toEqual(AS);
        } finally {
            clearMcpAuth(server);
        }
    });

    test("a re-auth starts clean rather than exchanging against a stale server", () => {
        const server = "test-as-clear-" + Date.now();
        const p = new McpOAuthProvider(server, REDIRECT);
        p.saveAuthorizationServerInformation(AS);
        // `authorizeServer` calls this before every interactive login.
        clearMcpAuth(server);
        expect(p.authorizationServerInformation()).toBeUndefined();
    });
});

/**
 * Which servers offer a "sign in" action.
 *
 * The bug this pins: a server signed in once showed no way to sign in again,
 * so an expired session had no route back — the status still read "ready"
 * while every call was being refused.
 */
describe("MCP OAuth: when signing in applies", () => {
    const http = { type: "http" as const, url: "https://mcp.example.com/mcp" };

    test("a server configured for OAuth always offers it", () => {
        expect(isOAuthServer("test-cfg", { ...http, auth: "oauth" })).toBe(true);
    });

    test("a server that has ASKED for auth offers it, config flag or not", () => {
        // The common case: added as a plain URL, and only the 401 on first
        // connect reveals that it wants OAuth at all.
        expect(isOAuthServer("test-401", http)).toBe(false);
        expect(isOAuthServer("test-401", http, true)).toBe(true);
    });

    test("a server signed in before keeps offering it — this is the expiry case", () => {
        const server = "test-signed-in-" + Date.now();
        const p = new McpOAuthProvider(server, REDIRECT);
        try {
            expect(isOAuthServer(server, http)).toBe(false);
            p.saveTokens({ access_token: "at", token_type: "bearer" });
            // Nothing about the status changed — the tokens are what make the
            // action meaningful, and they stay meaningful once they expire.
            expect(isOAuthServer(server, http)).toBe(true);
        } finally {
            clearMcpAuth(server);
        }
    });

    test("a stdio server never offers it — it has no login of any kind", () => {
        const stdio = { type: "stdio" as const, command: "npx", args: ["server"] };
        expect(isOAuthServer("test-stdio", stdio, true)).toBe(false);
    });
});
