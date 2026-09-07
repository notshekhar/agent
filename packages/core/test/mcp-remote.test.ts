/**
 * Remote MCP servers, against a real HTTP server rather than a mocked SDK.
 *
 * Every case here is a bug someone hit with a working server and a correct
 * config: a login that could never complete because the authorization request
 * carried no `state` and asked for no scope, an SSE-only server reported as
 * unreachable because the entry said `http`, and a server waiting to be signed
 * in to shown as broken.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connectServer } from "../src/mcp/client";
import { McpManager } from "../src/mcp/manager";
import { authorizeServer, registrationAdvice } from "../src/mcp/authorize";
import { clearMcpAuth, hasStoredTokens } from "../src/mcp/oauth";
import { McpOAuthProvider } from "../src/mcp/oauth";
import type { HttpServerConfig } from "../src/mcp/config";
import {
    ACCESS_TOKEN,
    CLIENT_ID,
    CLIENT_SECRET,
    REQUIRED_SCOPE,
    startMockRemoteServer,
    type MockRemoteServer,
} from "./fixtures/remote-mcp-server";

const cleanup: Array<() => void> = [];

afterEach(() => {
    while (cleanup.length) cleanup.pop()?.();
});

function serve(mode: "sse" | "unauthorized" | "oauth"): MockRemoteServer {
    const server = startMockRemoteServer(mode);
    cleanup.push(() => server.close());
    return server;
}

/** A server name nothing else in the suite (or on this machine) can collide with. */
function scratchName(prefix: string): string {
    const name = `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
    cleanup.push(() => clearMcpAuth(name));
    return name;
}

describe("OAuth: the authorization request itself", () => {
    test("each authorization gets a fresh, unguessable state", () => {
        const name = scratchName("state");
        const provider = new McpOAuthProvider(name, "http://127.0.0.1:8976/callback");
        const first = provider.state();
        const second = provider.state();
        expect(first.length).toBeGreaterThanOrEqual(32);
        expect(second).not.toBe(first);
        // The SDK mints with state() and persists with saveState(); storedState()
        // is what its CSRF check compares the callback against, so the pair has
        // to round-trip or the check silently passes on everything.
        provider.saveState(first);
        expect(provider.storedState()).toBe(first);
    });

    test("a Figma-shaped login completes: state sent, scope discovered, code exchanged", async () => {
        const mock = serve("oauth");
        const name = scratchName("oauth");
        const cfg: HttpServerConfig = {
            type: "http",
            url: mock.url,
            auth: "oauth",
            // No scopes configured, and registration is forbidden — the two
            // things that made this flow unusable for Figma and Slack.
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
        };

        let authorizationUrl: URL | undefined;
        await authorizeServer(name, cfg, (raw) => {
            authorizationUrl = new URL(raw);
            // Play the browser: the user consents and the provider redirects
            // back to the loopback callback with the code and our state.
            const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
            redirect.searchParams.set("code", "authorization-code");
            const state = authorizationUrl.searchParams.get("state");
            if (state) redirect.searchParams.set("state", state);
            void fetch(redirect).catch(() => {});
        });

        expect(authorizationUrl).toBeDefined();
        const params = authorizationUrl!.searchParams;
        expect(params.get("state")).toBeTruthy();
        expect(params.get("scope")).toBe(REQUIRED_SCOPE);
        expect(params.get("client_id")).toBe(CLIENT_ID);
        expect(params.get("code_challenge_method")).toBe("S256");
        // Registration is never attempted for a pre-registered client.
        expect(mock.requests).not.toContain("POST /oauth/register");
        expect(hasStoredTokens(name)).toBe(true);
    });

    test("tokens from a completed login are used on a later connect, with no auth flag set", async () => {
        const mock = serve("oauth");
        const name = scratchName("reuse");
        const cfg: HttpServerConfig = {
            type: "http",
            url: mock.url,
            auth: "oauth",
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
        };
        await authorizeServer(name, cfg, (raw) => {
            const authorizationUrl = new URL(raw);
            const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
            redirect.searchParams.set("code", "authorization-code");
            redirect.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
            void fetch(redirect).catch(() => {});
        });

        // The entry as `mcp add --transport http` writes it: a URL and nothing
        // else. The stored session still has to be what connects it.
        const plain: HttpServerConfig = { type: "http", url: mock.url };
        const { client, toolCount } = await connectServer(name, plain);
        cleanup.push(() => void client.close().catch(() => {}));
        expect(toolCount).toBe(1);
        expect(ACCESS_TOKEN).toBeTruthy();
    });
});

describe("remote servers that don't connect", () => {
    test("an SSE-only server declared as http is retried over SSE", async () => {
        const mock = serve("sse");
        const { client, tools, toolCount } = await connectServer("sse-fallback", { type: "http", url: mock.url });
        cleanup.push(() => void client.close().catch(() => {}));
        expect(toolCount).toBe(1);
        expect(Object.keys(tools)).toEqual(["mcp__sse_fallback__echo"]);
        // It really did try streamable HTTP first, and really did fall back.
        expect(mock.requests).toContain("POST /mcp");
        expect(mock.requests).toContain("GET /mcp");
    });

    test("a 401 from a plain remote URL is needs-auth, not error", async () => {
        const mock = serve("unauthorized");
        const manager = new McpManager();
        cleanup.push(() => void manager.close().catch(() => {}));
        // No `auth: "oauth"` — the flag almost nobody sets, because a server
        // announces its need for a login by refusing the first request.
        await manager.adopt("needs-login", { type: "http", url: mock.url });
        const server = manager.getServer("needs-login");
        expect(server?.status).toBe("needs-auth");
        // needs-auth carries no error text — the panels key the "authorize"
        // action off the status and print `error` when there is one, so a
        // leftover transport message here would read as a broken server again.
        expect(server?.error).toBeUndefined();
        expect(server?.toolCount).toBe(0);
    });
});

/**
 * When a login cannot succeed, the message has to say which kind of "cannot".
 * Figma's registration endpoint allow-lists client names against its MCP
 * Catalog, so the standard advice — go register an OAuth app — sends the user
 * to make credentials the server will refuse just the same.
 */
describe("advice for a server that refuses registration", () => {
    test("names the allow-list and the working alternative for Figma", () => {
        const advice = registrationAdvice("https://mcp.figma.com/mcp");
        expect(advice).toContain("Figma MCP Catalog");
        expect(advice).toContain("http://127.0.0.1:3845/mcp");
        expect(advice).not.toContain("clientSecret");
    });

    test("falls back to registering an OAuth app for everyone else", () => {
        const advice = registrationAdvice("https://mcp.example.com/mcp");
        expect(advice).toContain("clientId");
        expect(advice).not.toContain("Figma");
    });

    test("a URL it cannot parse still produces advice rather than throwing", () => {
        expect(registrationAdvice("not a url")).toContain("clientId");
    });
});
