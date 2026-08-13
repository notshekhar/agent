/**
 * MCP servers, the GUI half of the terminal's `/mcp` panel.
 *
 * Everything here is loop's own — connecting, adding, enabling, deleting and
 * the OAuth browser login all live in `packages/core/src/mcp` and are reached
 * through the RPC methods added alongside this file. Nothing is reimplemented:
 * this narrows the wire shapes and hands them to a component.
 *
 * Same degradation rule as [[insights]]: an older loop without the `mcp.*`
 * methods returns null rather than throwing, so the panel can say "this loop
 * cannot manage MCP" instead of taking the settings screen down with it.
 */
import { loopCall } from "./transport.ts";

export type McpStatus = "disabled" | "connecting" | "ready" | "error" | "needs-auth";
export type McpScope = "global" | "project";
export type McpTransport = "stdio" | "http" | "sse";

export interface McpServer {
  readonly name: string;
  readonly scope: McpScope;
  readonly transport: McpTransport;
  readonly status: McpStatus;
  readonly enabled: boolean;
  readonly toolCount: number;
  readonly error?: string;
  readonly command?: string;
  readonly url?: string;
  readonly oauth: boolean;
  readonly authorized?: boolean;
  readonly tools?: readonly string[];
}

export interface McpOverview {
  /** loop's master `mcp` setting. Every server is inert when false. */
  readonly enabled: boolean;
  readonly servers: readonly McpServer[];
  readonly projectConfigPath: string;
  /**
   * Whether loop has actually connected in this process. Until it has, every
   * status is the configured one, not a live one — the panel says so rather
   * than showing a green "ready" it cannot vouch for.
   */
  readonly connected: boolean;
}

/** What `mcp.add` accepts. Mirrors loop's `McpServerConfig`. */
export type McpServerInput =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "http" | "sse";
      readonly url: string;
      readonly auth?: "oauth";
      readonly headers?: Readonly<Record<string, string>>;
      readonly clientId?: string;
      readonly clientSecret?: string;
      readonly scopes?: readonly string[];
    };

/**
 * The configured servers, without connecting.
 *
 * Deliberately cheap: connecting is up to 30s per server loop-side, so the
 * panel draws from configuration first and asks for `refreshMcpServers` when
 * the user wants the live picture.
 */
export async function readMcpServers(cwd: string | null): Promise<McpOverview | null> {
  try {
    const result = await loopCall<McpOverview>("mcp.list", cwd ? { cwd } : {}, cwd ?? undefined);
    return result && Array.isArray(result.servers) ? result : null;
  } catch {
    return null;
  }
}

/** Connect (or reconnect) — one server by name, or all of them. */
export async function refreshMcpServers(
  cwd: string | null,
  name?: string,
): Promise<McpOverview | null> {
  try {
    const result = await loopCall<McpOverview>(
      "mcp.reconnect",
      { ...(cwd ? { cwd } : {}), ...(name ? { name } : {}) },
      cwd ?? undefined,
    );
    return result && Array.isArray(result.servers) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Add a server. Throws on a bad config — loop validates rather than writing an
 * entry that could never connect, and the message is what the form shows.
 */
export async function addMcpServer(input: {
  readonly cwd: string | null;
  readonly name: string;
  readonly scope: McpScope;
  readonly config: McpServerInput;
}): Promise<void> {
  await loopCall(
    "mcp.add",
    {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      name: input.name,
      scope: input.scope,
      config: input.config,
    },
    input.cwd ?? undefined,
  );
}

export async function removeMcpServer(
  cwd: string | null,
  name: string,
  scope: McpScope,
): Promise<boolean> {
  const result = await loopCall<{ ok?: boolean }>(
    "mcp.remove",
    { ...(cwd ? { cwd } : {}), name, scope },
    cwd ?? undefined,
  );
  return result?.ok === true;
}

export async function setMcpServerEnabled(
  cwd: string | null,
  name: string,
  scope: McpScope,
  value: boolean,
): Promise<boolean> {
  const result = await loopCall<{ ok?: boolean }>(
    "mcp.setEnabled",
    { ...(cwd ? { cwd } : {}), name, scope, value },
    cwd ?? undefined,
  );
  return result?.ok === true;
}

// ─── The OAuth login ──────────────────────────────────────────────────────────

export type McpLoginEvent =
  | { readonly type: "auth"; readonly url: string }
  | { readonly type: "progress"; readonly message: string }
  | { readonly type: "done"; readonly message: string }
  | { readonly type: "error"; readonly message: string };

export type McpLoginStatus = "running" | "done" | "error" | "cancelled";

export interface McpLoginPoll {
  readonly status: McpLoginStatus;
  readonly cursor: number;
  readonly events: readonly McpLoginEvent[];
}

/**
 * Start the browser login. Returns the id to poll.
 *
 * loop runs discovery, registration, consent and the token exchange itself and
 * owns the localhost callback — the client's only jobs are to open the URL it
 * is handed and to keep polling. Which also means this only works when loop is
 * on the same machine as the browser; over `loop serve` from another box the
 * callback would land on the wrong host.
 */
export async function startMcpLogin(
  cwd: string | null,
  name: string,
): Promise<string> {
  const result = await loopCall<{ flowId: string }>(
    "mcp.login.start",
    // The cwd travels with the request: a project-scoped server lives in the
    // repo's own mcp.json, and loop cannot find its config without knowing
    // which repo — it has not necessarily connected the server yet.
    { name, ...(cwd ? { cwd } : {}) },
    cwd ?? undefined,
  );
  if (!result?.flowId) throw new Error("loop did not start the authorization");
  return result.flowId;
}

export async function pollMcpLogin(
  cwd: string | null,
  flowId: string,
  cursor: number,
): Promise<McpLoginPoll | null> {
  try {
    return await loopCall<McpLoginPoll>(
      "mcp.login.poll",
      { flowId, cursor },
      cwd ?? undefined,
    );
  } catch {
    return null;
  }
}

export async function cancelMcpLogin(cwd: string | null, flowId: string): Promise<void> {
  await loopCall("mcp.login.cancel", { flowId }, cwd ?? undefined).catch(() => undefined);
}

/** Whether this loop can manage MCP at all — see `server.info` as the handshake. */
export async function supportsMcp(): Promise<boolean> {
  try {
    const info = await loopCall<{ methods?: readonly string[] }>("server.info", {});
    // Fail OPEN when the handshake itself fails: a missing `server.info` is a
    // transport problem, not proof that MCP is absent.
    if (!info || !Array.isArray(info.methods)) return true;
    return info.methods.includes("mcp.list");
  } catch {
    return true;
  }
}
