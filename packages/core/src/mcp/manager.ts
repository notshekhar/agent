/**
 * Long-lived MCP connections. Clients hold subprocesses/sockets, so they are
 * created once at startup (not per turn) and reused across the session. The
 * agent loop reads aggregated tools via the module singleton; the /mcp panel
 * reads status snapshots and drives authorize/enable/remove.
 */
import { brandEnv } from "../brand";
import { UnauthorizedError } from "@ai-sdk/mcp";
import { connectServer, serverPrefix, type McpClient, type McpToolSet } from "./client";
import {
    addServer,
    isServerEnabled,
    loadMcpServers,
    removeServer,
    setServerEnabled,
    type McpServerConfig,
} from "./config";
import { authorizeServer } from "./authorize";
import { clearMcpAuth, McpAuthRequiredError } from "./oauth";

export type ServerStatus = "disabled" | "connecting" | "ready" | "error" | "needs-auth";

/**
 * Hard ceiling on a single server's connect (spawn + handshake + tools/list). A
 * stdio child that wedges on startup, or an HTTP server that accepts the socket
 * but never replies, would otherwise leave `connectServer` pending forever —
 * the status stays "connecting" and, in print mode (which awaits init), the
 * whole run hangs. Racing against a timeout turns that into a normal `error`
 * status the user can see and retry. Overridable via LOOP_MCP_CONNECT_TIMEOUT_MS.
 */
const CONNECT_TIMEOUT_MS = Number(brandEnv("MCP_CONNECT_TIMEOUT_MS")) || 30_000;

/**
 * A rejecting timer plus a `clear()` so a fast connect doesn't leave the
 * 30s timer pinning the event loop open (which would hang a CLI exit or a test
 * run). Caller clears it in a `finally`.
 */
function connectTimeout(name: string): { promise: Promise<never>; clear: () => void } {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`connection to "${name}" timed out after ${CONNECT_TIMEOUT_MS}ms`)),
            CONNECT_TIMEOUT_MS,
        );
    });
    return { promise, clear: () => clearTimeout(timer) };
}

export interface ServerState {
    name: string;
    status: ServerStatus;
    toolCount: number;
    error?: string;
    config: McpServerConfig;
    client?: McpClient;
}

/** Status snapshot for the /mcp panel — no live client handle leaked. */
export type ServerSnapshot = Omit<ServerState, "client">;

export class McpManager {
    private servers = new Map<string, ServerState>();
    private tools: McpToolSet = {};
    private initialized = false;
    private cwd = process.cwd();
    /**
     * Bumped for a server every time something new is asked of it. A connect
     * carries the generation it started under and refuses to write its result
     * if that number has moved — otherwise a connect still in flight when the
     * user hits delete lands afterwards and puts the server back, tools and
     * all, with a live client nobody will ever close.
     */
    private generations = new Map<string, number>();

    /** Connect every enabled server in parallel. Safe to call once per session. */
    async init(cwd: string): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        this.cwd = cwd;
        const configs = loadMcpServers(cwd);
        await Promise.allSettled(Object.entries(configs).map(([name, cfg]) => this.connectOne(name, cfg)));
    }

    /** Claim the next generation for a server; the caller's connect owns it. */
    private nextGeneration(name: string): number {
        const next = (this.generations.get(name) ?? 0) + 1;
        this.generations.set(name, next);
        return next;
    }

    /** Invalidate whatever is in flight for a server (delete, disable, reconnect). */
    private supersede(name: string): void {
        this.nextGeneration(name);
    }

    private async connectOne(name: string, cfg: McpServerConfig): Promise<void> {
        const generation = this.nextGeneration(name);
        const current = () => this.generations.get(name) === generation;
        if (!isServerEnabled(cfg)) {
            this.servers.set(name, { name, status: "disabled", toolCount: 0, config: cfg });
            return;
        }
        // Two servers whose names differ only in characters the tool-name
        // charset can't carry ("my-fs" and "my.fs") share a prefix, so the
        // second one's tools would silently overwrite the first's and removing
        // either would drop both. Say so instead.
        const clash = this.prefixClash(name);
        if (clash) {
            this.servers.set(name, {
                name,
                status: "error",
                toolCount: 0,
                config: cfg,
                error: `tool prefix ${serverPrefix(name)} collides with server "${clash}" — rename one of them`,
            });
            return;
        }
        this.servers.set(name, { name, status: "connecting", toolCount: 0, config: cfg });
        const connecting = connectServer(name, cfg, (err) => this.markDisconnected(name, generation, err));
        const timeout = connectTimeout(name);
        try {
            const { client, tools, toolCount } = await Promise.race([connecting, timeout.promise]);
            if (!current()) {
                // Removed, disabled or reconnected while we were connecting:
                // this result belongs to nobody. Close it rather than leaking it.
                await client.close().catch(() => {});
                return;
            }
            // Tool keys are already namespaced with this server's prefix by
            // connectServer, so a plain merge can't clobber another server.
            Object.assign(this.tools, tools);
            this.servers.set(name, { name, status: "ready", toolCount, config: cfg, client });
        } catch (err) {
            if (current()) this.setFailed(name, cfg, err);
            // If the timer won the race, the connect may still resolve later with
            // a live subprocess/socket — close it so the timeout doesn't leak it.
            void connecting.then(({ client }) => client.close()).catch(() => {});
        } finally {
            timeout.clear();
        }
    }

    /**
     * Another server that would namespace its tools identically. Counts one
     * that is still connecting, not just a connected one: `init` connects every
     * server at once, so at check time the twin usually hasn't finished yet.
     */
    private prefixClash(name: string): string | undefined {
        const prefix = serverPrefix(name);
        for (const other of this.servers.values()) {
            if (other.name === name) continue;
            if (other.status !== "ready" && other.status !== "connecting") continue;
            if (serverPrefix(other.name) === prefix) return other.name;
        }
        return undefined;
    }

    /**
     * The connection died on its own — the stdio child exited, the socket
     * dropped, the transport errored. Without this the server sat at "ready"
     * forever while its tools stayed in every subsequent turn's tool set, so
     * the model kept calling things that could only fail. Marked error and its
     * tools withdrawn; `/mcp reconnect` brings it back.
     */
    private markDisconnected(name: string, generation: number, err: unknown): void {
        if (this.generations.get(name) !== generation) return;
        const server = this.servers.get(name);
        if (!server || server.status !== "ready") return;
        this.dropTools(name);
        this.servers.set(name, {
            ...server,
            status: "error",
            toolCount: 0,
            client: undefined,
            error: `disconnected: ${describe(err)}`,
        });
        void server.client?.close().catch(() => {});
    }

    /** OAuth servers that aren't logged in get a distinct, actionable status. */
    private setFailed(name: string, cfg: McpServerConfig, err: unknown): void {
        const needsAuth = err instanceof McpAuthRequiredError || err instanceof UnauthorizedError;
        this.servers.set(name, {
            name,
            status: needsAuth ? "needs-auth" : "error",
            toolCount: 0,
            config: cfg,
            error: needsAuth ? undefined : describe(err),
        });
    }

    /** Aggregated, namespaced tool set for the agent loop. Empty until init. */
    getTools(): McpToolSet {
        return this.tools;
    }

    listServers(): ServerSnapshot[] {
        return [...this.servers.values()].map(({ client: _client, ...rest }) => rest);
    }

    getServer(name: string): ServerSnapshot | undefined {
        const s = this.servers.get(name);
        if (!s) return undefined;
        const { client: _client, ...rest } = s;
        return rest;
    }

    hasServers(): boolean {
        return this.servers.size > 0;
    }

    /** Persist a new global server, then connect it. Used by the /mcp add flow. */
    async add(name: string, cfg: McpServerConfig): Promise<void> {
        addServer(name, cfg);
        const existing = this.servers.get(name);
        if (existing) await this.closeOne(existing);
        await this.connectOne(name, cfg);
    }

    /**
     * Connect a server whose config is already persisted elsewhere.
     *
     * `add` writes to the GLOBAL settings file, so it cannot serve a
     * project-scoped server (`.loop/mcp.json`) — and `reconnect` only walks
     * servers this process already knows, which a just-written one is not.
     * Without this a project server stayed invisible until the next launch.
     */
    async adopt(name: string, cfg: McpServerConfig): Promise<void> {
        const existing = this.servers.get(name);
        if (existing) await this.closeOne(existing);
        await this.connectOne(name, cfg);
    }

    /** Forget a server this process connected, without touching any config. */
    async forget(name: string): Promise<boolean> {
        this.supersede(name);
        const existing = this.servers.get(name);
        if (!existing) return false;
        await this.closeOne(existing);
        this.servers.delete(name);
        return true;
    }

    /**
     * Reconnect one server (or all), from the config as it is on disk RIGHT
     * NOW. Used by /mcp reconnect.
     *
     * It used to reconnect from the config in memory, which made it useless for
     * the thing people actually reach for it after: editing settings.json or
     * .loop/mcp.json to fix a server. A corrected command reconnected with the
     * old one, and a newly added server never appeared at all — `init()` is a
     * no-op after the first call, so nothing re-read the file. Now the file is
     * the source of truth again: added servers connect, edited ones use their
     * new config, and ones deleted from disk are dropped.
     */
    async reconnect(name?: string): Promise<void> {
        const onDisk = loadMcpServers(this.cwd);
        if (name) {
            const cfg = onDisk[name] ?? this.servers.get(name)?.config;
            if (!cfg) {
                await this.forget(name);
                return;
            }
            const existing = this.servers.get(name);
            if (existing) await this.closeOne(existing);
            await this.connectOne(name, cfg);
            return;
        }
        for (const server of [...this.servers.values()]) {
            await this.closeOne(server);
            // Deleted from the file since we loaded it — reconnect means "match
            // the config", so it goes rather than lingering as a ghost row.
            if (!(server.name in onDisk)) {
                this.supersede(server.name);
                this.servers.delete(server.name);
            }
        }
        await Promise.allSettled(Object.entries(onDisk).map(([n, cfg]) => this.connectOne(n, cfg)));
    }

    /** Run the browser OAuth login for a server, then connect it. */
    async authorize(name: string, openUrl: (url: string) => void, cfg?: McpServerConfig): Promise<void> {
        const server = this.servers.get(name);
        // A caller holding the config can sign in to a server this process has
        // never connected — a settings page lists from disk without connecting
        // (that costs up to 30s per server), and "reconnect before you can sign
        // in" is a step nobody should have to know about.
        const config = server?.config ?? cfg;
        if (!config) throw new Error(`unknown MCP server: ${name}`);
        await authorizeServer(name, config, openUrl);
        if (server) await this.closeOne(server);
        await this.connectOne(name, config);
    }

    /** Toggle a global server on/off, persisting the choice and (dis)connecting. */
    async setEnabled(name: string, enabled: boolean): Promise<boolean> {
        const server = this.servers.get(name);
        if (!server) return false;
        if (!setServerEnabled(name, enabled)) return false;
        const cfg: McpServerConfig = { ...server.config, enabled };
        this.supersede(name);
        await this.closeOne(server);
        if (enabled) {
            await this.connectOne(name, cfg);
        } else {
            this.servers.set(name, { name, status: "disabled", toolCount: 0, config: cfg });
        }
        return true;
    }

    /** Delete a global server: disconnect, forget its OAuth session, drop config. */
    async remove(name: string): Promise<boolean> {
        // Before anything else: a connect still in flight for this name must not
        // be allowed to write itself back in once it lands.
        this.supersede(name);
        const server = this.servers.get(name);
        if (server) await this.closeOne(server);
        clearMcpAuth(name);
        this.servers.delete(name);
        return removeServer(name);
    }

    async close(): Promise<void> {
        for (const name of this.servers.keys()) this.supersede(name);
        await Promise.allSettled([...this.servers.values()].map((s) => this.closeOne(s)));
        this.tools = {};
        this.servers.clear();
        this.initialized = false;
    }

    private async closeOne(server: ServerState): Promise<void> {
        try {
            await server.client?.close();
        } catch {
            // Best-effort teardown — a wedged transport shouldn't block exit.
        }
        this.dropTools(server.name);
    }

    private dropTools(name: string): void {
        const prefix = serverPrefix(name);
        for (const key of Object.keys(this.tools)) {
            if (key.startsWith(prefix)) delete this.tools[key];
        }
    }
}

/** An error as a line a user can read. */
function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

let singleton: McpManager | undefined;

export function getMcpManager(): McpManager {
    if (!singleton) singleton = new McpManager();
    return singleton;
}
