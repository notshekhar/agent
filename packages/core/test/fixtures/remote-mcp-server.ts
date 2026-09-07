/**
 * A remote MCP server, in the three shapes that broke loop in the field.
 *
 * `sse` speaks the older SSE transport and answers a streamable-HTTP POST the
 * way such a server really does — 405, no explanation. `unauthorized` refuses
 * everything with a bare 401, which is what a remote server added as a plain
 * URL looks like before its owner signs in. `oauth` is shaped like Figma:
 * dynamic client registration is forbidden, the 401 names both a
 * protected-resource document and a required scope, and the authorization
 * server declares `require_state_parameter`.
 */
import type { Server } from "bun";

export type ServerMode = "sse" | "unauthorized" | "oauth";

export interface MockRemoteServer {
    url: string;
    origin: string;
    /** Every request the server saw, as "METHOD /path". */
    requests: string[];
    /** Authorization URLs handed to the browser opener, for assertions. */
    close(): void;
}

const TOOLS = [
    {
        name: "echo",
        description: "Echo back the provided text.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
];

/** The scope this fixture requires, mirroring Figma's `mcp:connect`. */
export const REQUIRED_SCOPE = "mock:connect";
export const CLIENT_ID = "preregistered-client";
export const CLIENT_SECRET = "preregistered-secret";
export const ACCESS_TOKEN = "granted-access-token";

interface JsonRpc {
    id?: number | string;
    method?: string;
    params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

function handleRpc(body: JsonRpc): unknown | undefined {
    const { id, method, params } = body;
    if (method === "initialize") {
        return {
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: params?.protocolVersion ?? "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "mock-remote-mcp", version: "0.0.0" },
            },
        };
    }
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "tools/call") {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${params?.arguments?.text}` }] } };
    }
    if (id === undefined) return undefined; // a notification needs no reply
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

export function startMockRemoteServer(mode: ServerMode): MockRemoteServer {
    const requests: string[] = [];
    // One SSE stream is enough: these tests connect a single client at a time.
    let push: ((chunk: string) => void) | undefined;

    const server: Server = Bun.serve({
        port: 0,
        idleTimeout: 0,
        async fetch(req) {
            const url = new URL(req.url);
            requests.push(`${req.method} ${url.pathname}`);
            const origin = `http://127.0.0.1:${server.port}`;

            if (mode === "unauthorized") return unauthorized(origin);

            if (mode === "oauth") {
                const oauthResponse = await handleOAuth(req, url, origin);
                if (oauthResponse) return oauthResponse;
            }

            // --- SSE transport -------------------------------------------------
            if (url.pathname === "/mcp" && req.method === "GET" && mode === "sse") {
                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        const encoder = new TextEncoder();
                        push = (chunk) => controller.enqueue(encoder.encode(chunk));
                        push(`event: endpoint\ndata: /messages\n\n`);
                    },
                });
                return new Response(stream, {
                    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
                });
            }
            if (url.pathname === "/messages" && req.method === "POST") {
                const reply = handleRpc((await req.json()) as JsonRpc);
                if (reply) push?.(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
                return new Response(null, { status: 202 });
            }

            // --- streamable HTTP transport -------------------------------------
            if (url.pathname === "/mcp" && req.method === "POST") {
                // An SSE-only server has no POST endpoint here at all, and says
                // so with the least helpful status it can: 405, no body.
                if (mode === "sse") return new Response(null, { status: 405 });
                const reply = handleRpc((await req.json()) as JsonRpc);
                if (!reply) return new Response(null, { status: 202 });
                return Response.json(reply);
            }
            return new Response("not found", { status: 404 });
        },
    });

    return {
        url: `http://127.0.0.1:${server.port}/mcp`,
        origin: `http://127.0.0.1:${server.port}`,
        requests,
        close: () => server.stop(true),
    };
}

function unauthorized(origin: string, scope?: string): Response {
    const challenge = scope
        ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource",scope="${scope}"`
        : `Bearer`;
    return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": challenge } });
}

/** The OAuth half of the Figma-shaped server. Returns undefined for MCP traffic. */
async function handleOAuth(req: Request, url: URL, origin: string): Promise<Response | undefined> {
    if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            bearer_methods_supported: ["header"],
            scopes_supported: [REQUIRED_SCOPE],
        });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/oauth/token`,
            registration_endpoint: `${origin}/oauth/register`,
            grant_types_supported: ["authorization_code", "refresh_token"],
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            scopes_supported: [REQUIRED_SCOPE],
            require_state_parameter: true,
        });
    }
    // Like Figma: anonymous registration is forbidden, and the body isn't even
    // JSON, so a client that tries it fails twice over.
    if (url.pathname === "/oauth/register") return new Response("Forbidden", { status: 403 });

    if (url.pathname === "/oauth/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
            return Response.json({ error: "invalid_client" }, { status: 401 });
        }
        if (!form.get("code_verifier")) return Response.json({ error: "invalid_request" }, { status: 400 });
        return Response.json({
            access_token: ACCESS_TOKEN,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "granted-refresh-token",
            scope: REQUIRED_SCOPE,
        });
    }

    if (url.pathname === "/mcp") {
        const bearer = req.headers.get("authorization");
        if (bearer !== `Bearer ${ACCESS_TOKEN}`) return unauthorized(origin, REQUIRED_SCOPE);
    }
    return undefined;
}
