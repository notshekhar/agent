/**
 * `loop serve` — the RPC server over WebSocket, plus an embedded browser UI.
 *
 * Each WS connection wraps into one `Transport` fed to the shared RpcServer:
 * frames are the existing JSONL messages, one JSON message per text frame, so
 * every RPC client (TUI-attach later, the web UI now) speaks the same
 * protocol as the unix-socket daemon.
 *
 * Security model (see settings.serve): possession of the token is full
 * control of this machine. Token required on the WS upgrade AND the page
 * load; default bind is loopback — remote reach is the user's own network
 * (Tailscale / SSH -L / cloudflared), TLS included.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { RpcServer } from "./server";
import { getStoredServeToken, storeServeToken } from "./serve-token-store";
// bun-types declares *.html as HTMLBundle (the fullstack-route loader); the
// `type: "text"` attribute overrides the loader to a plain inlined string in
// both the runtime and Bun.build, so re-type it through unknown.
import webUiHtml from "./web-ui.html" with { type: "text" };

const WEB_UI_HTML = webUiHtml as unknown as string;

/** Keypad-spellable default: 5667 = "loop". */
export const SERVE_DEFAULT_PORT = 5667;

/** Existing token from auth.json, or a fresh one persisted for next time —
 * the printed URL stays stable across restarts. */
export function getOrCreateServeToken(): string {
    const existing = getStoredServeToken();
    if (existing) return existing;
    const token = randomBytes(24).toString("hex");
    storeServeToken(token);
    return token;
}

export function isLoopbackHost(host: string): boolean {
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Non-internal IPv4 addresses of this machine — the LAN faces of a serve
 * bound to a wildcard host. */
export function lanAddresses(): string[] {
    const out: string[] = [];
    for (const infos of Object.values(networkInterfaces())) {
        for (const info of infos ?? []) {
            if (info.family === "IPv4" && !info.internal) out.push(info.address);
        }
    }
    return out;
}

/** The SPA is served for `/` and every session deep link — `/session/<id>`
 * reloads must land on the app, which then opens that session client-side. */
const SESSION_PATH = /^\/session\/[A-Za-z0-9]+$/;

/** Constant-time compare via digests — no length or prefix leak. */
function tokenMatches(candidate: string | null, token: string): boolean {
    if (!candidate) return false;
    const a = createHash("sha256").update(candidate).digest();
    const b = createHash("sha256").update(token).digest();
    return timingSafeEqual(a, b);
}

export interface ServeHandle {
    hostname: string;
    port: number;
    /** Ready-to-open URL including the token. Never log it server-side. */
    url: string;
    /** LAN URLs (one per non-internal IPv4). Only usable when the bind host
     * actually faces the network — empty for a loopback bind. */
    networkUrls: string[];
    stop(): void;
}

interface WsData {
    /** JSONL feed into the shared RpcServer; wired in open(). */
    feed: ((chunk: string) => void) | null;
    /** Unsubscribes this connection from every session on close. */
    close: (() => void) | null;
}

export function startWebServer(opts: { host?: string; port?: number } = {}): ServeHandle {
    const hostname = opts.host ?? "127.0.0.1";
    const port = opts.port ?? SERVE_DEFAULT_PORT;
    const token = getOrCreateServeToken();
    const rpc = new RpcServer();

    const unauthorized = () =>
        new Response("Unauthorized: token required (start with `serve` and use the printed URL)", { status: 401 });

    const server = Bun.serve<WsData, never>({
        hostname,
        port,
        fetch(req, srv) {
            const url = new URL(req.url);
            if (!tokenMatches(url.searchParams.get("token"), token)) return unauthorized();
            if (url.pathname === "/ws") {
                const data: WsData = { feed: null, close: null };
                if (srv.upgrade(req, { data })) return undefined;
                return new Response("WebSocket upgrade failed", { status: 400 });
            }
            if (
                (url.pathname === "/" || SESSION_PATH.test(url.pathname)) &&
                (req.method === "GET" || req.method === "HEAD")
            ) {
                return new Response(WEB_UI_HTML, {
                    headers: { "content-type": "text/html; charset=utf-8" },
                });
            }
            return new Response("Not found", { status: 404 });
        },
        websocket: {
            open(ws) {
                // One Transport per connection, alive for the socket's
                // lifetime. Turn events for sessions this connection opened
                // keep flowing here; after close, sends are dropped by the
                // dead-socket guard below (until per-session subscriber sets —
                // the multi-client phase — replace this wiring).
                const transport = {
                    send(msg: unknown) {
                        // A turn event can fire between close and GC; Bun
                        // returns -1 on a dead socket, but stay defensive.
                        try {
                            ws.send(JSON.stringify(msg));
                        } catch {}
                    },
                };
                const attached = rpc.attach(transport);
                ws.data.feed = attached.feed;
                ws.data.close = attached.close;
            },
            message(ws, message) {
                // One JSON message per text frame; the JSONL feed just needs
                // its newline delimiter appended.
                const { feed } = ws.data;
                if (typeof message === "string" && feed) feed(message + "\n");
            },
            close(ws) {
                // Detach from every session so broadcasts stop going to a dead
                // socket and `attached` counts stay honest.
                if (ws.data.close) ws.data.close();
            },
        },
    });

    const boundPort = server.port ?? port;
    // Wildcard binds aren't clickable — the local URL always shows loopback.
    const wildcard = hostname === "0.0.0.0" || hostname === "::";
    const localHost = wildcard ? "127.0.0.1" : hostname;
    // A specific non-loopback bind has exactly one network face; a wildcard
    // bind faces every LAN address.
    const networkHosts = wildcard ? lanAddresses() : isLoopbackHost(hostname) ? [] : [hostname];
    return {
        hostname,
        port: boundPort,
        url: `http://${localHost}:${boundPort}/?token=${token}`,
        networkUrls: networkHosts.map((h) => `http://${h}:${boundPort}/?token=${token}`),
        stop: () => server.stop(true),
    };
}
