/**
 * Connects to a single MCP server and returns its tools, namespaced so they
 * never collide with loop's built-ins or another server's tools.
 */
import { brandEnv } from "../brand";
import { createMCPClient } from "@ai-sdk/mcp";
import { isHttpServer, type McpServerConfig } from "./config";
import { buildTransport } from "./transport";
import { oauthClientOptions, McpOAuthProvider } from "./oauth";

export type McpClient = Awaited<ReturnType<typeof createMCPClient>>;
export type McpToolSet = Record<string, unknown>;

export interface ConnectResult {
    client: McpClient;
    tools: McpToolSet;
    /** Number of tools the server exposed (after namespacing). */
    toolCount: number;
}

/** Tool/server name charset the AI SDK accepts in a tool key. */
const UNSAFE_NAME_CHARS = /[^a-zA-Z0-9_]/g;

function sanitize(name: string): string {
    return name.replace(UNSAFE_NAME_CHARS, "_");
}

/**
 * Providers cap a tool name at 64 characters (Anthropic's schema is
 * `^[a-zA-Z0-9_-]{1,64}$`, and OpenAI's is the same length). A long server name
 * plus a long tool name goes past that easily, and the provider rejects the
 * WHOLE request — so one verbose MCP server breaks every turn, not just its own
 * tool. Names are shortened from the middle of the tool half, keeping the
 * server prefix (which is how the model and our own routing find it) and enough
 * of the tool's head and tail to stay readable.
 */
const MAX_TOOL_NAME = 64;

function fitToolName(prefix: string, tool: string): string {
    const full = `${prefix}${tool}`;
    if (full.length <= MAX_TOOL_NAME) return full;
    const budget = MAX_TOOL_NAME - prefix.length;
    // Nothing sensible left once the prefix alone eats the budget — keep the
    // tail of the prefixed name so at least it stays unique-ish and valid.
    if (budget < 8) return full.slice(full.length - MAX_TOOL_NAME);
    const head = Math.ceil((budget - 1) / 2);
    const tail = budget - 1 - head;
    return `${prefix}${tool.slice(0, head)}_${tool.slice(tool.length - tail)}`;
}

/** Shared prefix for every tool from one server: `mcp__<server>__`. */
export function serverPrefix(server: string): string {
    return `mcp__${sanitize(server)}__`;
}

/** `mcp__<server>__<tool>` — the Claude Code convention, capped at 64 chars. */
export function namespacedToolName(server: string, tool: string): string {
    return fitToolName(serverPrefix(server), sanitize(tool));
}

/**
 * Hard ceiling on a single MCP tool call. A wedged stdio child or a dropped
 * HTTP connection can leave `callTool` pending forever — the agent loop then
 * awaits a result that never arrives and the whole UI appears frozen. Racing
 * each call against a timeout turns that hang into a normal tool error the
 * model can recover from. Overridable via LOOP_MCP_TOOL_TIMEOUT_MS.
 */
const MCP_TOOL_TIMEOUT_MS = Number(brandEnv("MCP_TOOL_TIMEOUT_MS")) || 120_000;

type ExecutableTool = { execute?: (input: unknown, options: unknown) => Promise<unknown> };

interface McpCallResult {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
}

function isMcpCallResult(value: unknown): value is McpCallResult {
    return typeof value === "object" && value !== null && ("content" in value || "structuredContent" in value);
}

/**
 * Preserve a tool's `structuredContent`. The AI SDK MCP client only maps a
 * result's `content` blocks into the model-facing output when the tool is
 * created with an explicit outputSchema; with the automatic schemas we use
 * (client.tools() with no args), `structuredContent` is dropped entirely. A
 * server that returns its real payload there with an empty `content` array
 * (e.g. codespec) then hands the model — and our persistence — nothing.
 *
 * So when a result carries structuredContent but no text block, surface it as a
 * text block. Generic: any structured-output MCP server benefits, no per-server
 * code. Servers that already return text content are left untouched.
 */
function preserveStructuredContent(result: unknown): unknown {
    if (!isMcpCallResult(result)) return result;
    if (result.structuredContent == null) return result;
    const content = Array.isArray(result.content) ? result.content : [];
    const hasText = content.some((part) => part?.type === "text" && part.text);
    if (hasText) return result;
    const asText = { type: "text", text: JSON.stringify(result.structuredContent, null, 2) };
    return { ...result, content: [...content, asText] };
}

/**
 * A rejection that means the connection is gone rather than the call failing.
 * The AI SDK reports both a transport that closed under a pending request
 * ("Connection closed") and a call made after that ("closed client") this way.
 */
const CLOSED_CONNECTION = /connection closed|closed client|transport closed|not connected/i;

export function isDisconnectError(err: unknown): boolean {
    return CLOSED_CONNECTION.test(err instanceof Error ? err.message : String(err));
}

/**
 * Wrap a tool's execute so a call that never settles rejects instead of
 * hanging, so structuredContent-only results aren't silently lost, and so a
 * connection that died is reported to the manager instead of being rediscovered
 * by every later call.
 *
 * The timeout also ABORTS the underlying request rather than just walking away
 * from it: the SDK forwards `options.abortSignal` down to callTool, so a timed
 * out call stops occupying the server (and, for stdio, stops holding a response
 * handler open forever) the moment we give up on it.
 */
function withTimeout(name: string, tool: ExecutableTool, onDisconnect?: (err: unknown) => void): ExecutableTool {
    if (typeof tool.execute !== "function") return tool;
    const original = tool.execute.bind(tool);
    return {
        ...tool,
        execute: (input: unknown, options: unknown) => {
            const abort = new AbortController();
            const caller = (options ?? {}) as { abortSignal?: AbortSignal };
            const onCallerAbort = () => abort.abort(caller.abortSignal?.reason);
            caller.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });
            let timer: ReturnType<typeof setTimeout>;
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    abort.abort();
                    reject(new Error(`MCP tool ${name} timed out after ${MCP_TOOL_TIMEOUT_MS}ms`));
                }, MCP_TOOL_TIMEOUT_MS);
            });
            const call = original(input, { ...caller, abortSignal: abort.signal });
            return Promise.race([call, timeout])
                .then(preserveStructuredContent)
                .catch((err: unknown) => {
                    if (isDisconnectError(err)) onDisconnect?.(err);
                    throw err;
                })
                .finally(() => {
                    clearTimeout(timer);
                    caller.abortSignal?.removeEventListener("abort", onCallerAbort);
                });
        },
    };
}

function namespaceTools(server: string, tools: McpToolSet, onDisconnect?: (err: unknown) => void): McpToolSet {
    const namespaced: McpToolSet = {};
    for (const [toolName, tool] of Object.entries(tools)) {
        const key = namespacedToolName(server, toolName);
        namespaced[key] = withTimeout(key, tool as ExecutableTool, onDisconnect);
    }
    return namespaced;
}

/**
 * Throws on connection failure — the manager catches per-server so one bad
 * server never takes down the rest. OAuth servers get a token-backed provider
 * (no browser opener) so the transport can refresh silently; if no tokens are
 * stored yet the provider throws McpAuthRequiredError, which the manager maps
 * to needs-auth.
 */
export async function connectServer(
    name: string,
    cfg: McpServerConfig,
    onDisconnect?: (err: unknown) => void,
): Promise<ConnectResult> {
    const authProvider =
        isHttpServer(cfg) && cfg.auth === "oauth"
            ? new McpOAuthProvider(name, oauthRefreshRedirectUri(), undefined, oauthClientOptions(cfg))
            : undefined;
    const transport = watchTransport(buildTransport(cfg, authProvider), onDisconnect);
    const client = await createMCPClient({
        name: `loop-mcp-${name}`,
        transport,
        // Async transport errors must not crash the process. They also mean this
        // connection is finished, which is the manager's business — its status
        // is what the /mcp panel and the next turn's tool set are built from.
        onUncaughtError: (err) => onDisconnect?.(err),
    });
    let rawTools: McpToolSet;
    try {
        rawTools = (await client.tools()) as McpToolSet;
    } catch (err) {
        // The handshake succeeded, so there is a live subprocess (or socket)
        // behind this client even though the connect as a whole failed. Nobody
        // else has a handle on it: without this the child outlives the process
        // that spawned it, and every retry orphans another one.
        await client.close().catch(() => {});
        throw err;
    }
    const tools = namespaceTools(name, rawTools, onDisconnect);
    return { client, tools, toolCount: Object.keys(tools).length };
}

/**
 * Learn when the connection dies.
 *
 * The SDK routes transport ERRORS to `onUncaughtError`, but a clean close — an
 * stdio child that exits, a socket the server hangs up — only reaches
 * `transport.onclose`, which the SDK claims for itself the moment the client is
 * constructed. So for a transport instance we own (stdio), the property is
 * re-defined to chain: the SDK's handler still runs, and ours runs after it.
 * HTTP transports are built inside the SDK from a config object and cannot be
 * hooked this way — they surface a dead connection through onUncaughtError, or
 * on the next call (see withTimeout).
 */
function watchTransport<T>(transport: T, onDisconnect?: (err: unknown) => void): T {
    if (!onDisconnect || typeof transport !== "object" || transport === null) return transport;
    let handler: (() => void) | undefined;
    try {
        Object.defineProperty(transport, "onclose", {
            configurable: true,
            get: () => handler,
            set: (fn: (() => void) | undefined) => {
                handler = () => {
                    fn?.();
                    onDisconnect(new Error("connection closed"));
                };
            },
        });
    } catch {
        // A sealed transport is not a reason to fail the connect; the call-time
        // path still catches the dead connection.
    }
    return transport;
}

/**
 * Redirect URI used only for token refresh on background connects. Matches the
 * callback server's preferred port so a server that allow-lists the URI accepts
 * it; refresh itself never sends the redirect, so the exact port rarely matters.
 */
function oauthRefreshRedirectUri(): string {
    const port = Number(brandEnv("MCP_OAUTH_CALLBACK_PORT")) || 8976;
    return `http://127.0.0.1:${port}/callback`;
}
