import { getConfigDir, PRODUCT_NAME } from "../brand";
import { createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type Session } from "../sessions";
import { runTurn, CostTracker, runCompact, TURN_EVENT_NAMES, buildContextReport } from "../agent";
import { THINKING_LEVELS, type ThinkingLevel } from "../agent/thinking";
import { bustCatalogCache, getCatalog, listUsableProviders } from "../catalog";
import { CommandRegistry, registerBuiltins } from "../commands";
import { getExtensionHost, setBuiltinEnabled, setRecordEnabled } from "../extensions";
import { listAuthorizedProviders, getActiveProvider, loginApiKey } from "../auth";
import { getSetting, setSetting, type AppSettings } from "../settings";
import { buildSteakGrid } from "../agent/steak";
import { RpcErrorCode, type RpcNotification, type RpcRequest, type RpcResponse } from "./protocol";
import type { ProviderId } from "../types";

/** Every method `dispatch` handles — surfaced via `server.info`. Keep in sync. */
const RPC_METHODS = [
    "server.info",
    "session.create",
    "session.list",
    "session.history",
    "session.open",
    "session.send",
    "session.cancel",
    "session.compact",
    "session.rename",
    "session.attach",
    "session.detach",
    "auth.status",
    "auth.login",
    "catalog.list",
    "cost.session",
    "cost.lifetime",
    "cost.stats",
    "usage.steak",
    "settings.list",
    "settings.set",
    "context.report",
    "extension.list",
    "extension.setEnabled",
] as const;

/**
 * Settings a remote client may read and toggle — the boolean rows of the
 * TUI's /settings screen. An allowlist (not a passthrough) so the RPC surface
 * can't write arbitrary keys; terminal-only toggles (clock, uiMode…) and
 * structured settings (hooks, sandbox…) stay local.
 */
const WEB_SETTINGS: ReadonlyArray<{ key: keyof AppSettings; label: string; description: string; def: boolean }> = [
    { key: "subagents", label: "subagents", description: "task tool: delegate work to parallel subagents", def: true },
    { key: "memory", label: "memory", description: "agent saves per-project facts across sessions", def: true },
    { key: "skills", label: "skills", description: "let the agent load project skills", def: true },
    { key: "recap", label: "recap", description: "short AI recap under responses that changed files", def: false },
    {
        key: "webSearch",
        label: "websearch",
        description: "websearch tool (DuckDuckGo scrape, may rate-limit)",
        def: false,
    },
    { key: "todos", label: "todos", description: "visible checklist during multi-step tasks", def: false },
    { key: "reminders", label: "reminders", description: "fire /reminder alerts", def: true },
    {
        key: "mcp",
        label: "mcp servers",
        description: "connect configured MCP servers and expose their tools",
        def: true,
    },
    {
        key: "serve",
        label: "serve (web UI)",
        description: "allow loop serve — turning this off blocks the NEXT serve start",
        def: false,
    },
];

/** Events kept per active session for reconnect replay (session.attach). */
const EVENT_RING_SIZE = 2048;

interface RingEntry {
    seq: number;
    part: { type: string; data: unknown };
}

interface ActiveSession {
    session: Session;
    tracker: CostTracker;
    abort: AbortController;
    emitter: EventEmitter;
    modelId: string;
    /** True while a turn (or compact) is running — concurrent sends on the
     * same session would interleave appends and corrupt the branch. */
    running: boolean;
    /** Transports receiving this session's events. Events broadcast to all;
     * input (send/cancel) is accepted from any of them. */
    subscribers: Set<Transport>;
    /** Monotonic per-session event counter; stamped on every session.event. */
    seq: number;
    /** Last EVENT_RING_SIZE events, for session.attach {afterSeq} replay. */
    ring: RingEntry[];
}

type Transport = {
    send(msg: RpcResponse | RpcNotification): void;
};

export class RpcServer {
    private sessions = new Map<string, ActiveSession>();
    private manager = new SessionManager();
    private commands = new CommandRegistry();
    /** Startup work (extensions, command registry) every request waits on —
     * otherwise an early session.send could run a turn before extension
     * tools/providers exist. */
    private ready: Promise<void>;

    constructor() {
        this.ready = (async () => {
            await getExtensionHost().init();
            await registerBuiltins(this.commands);
            getExtensionHost().applyCommands(this.commands);
        })();
    }

    attach(transport: Transport): { feed: (chunk: Buffer | string) => void; close: () => void } {
        let buffer = "";
        const feed = (chunk: Buffer | string) => {
            buffer += typeof chunk === "string" ? chunk : chunk.toString();
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (line) this.handleLine(line, transport);
            }
        };
        return { feed, close: () => this.disconnect(transport) };
    }

    /** Transport gone (socket/WS closed): stop broadcasting to it everywhere. */
    disconnect(transport: Transport): void {
        for (const ctx of this.sessions.values()) ctx.subscribers.delete(transport);
    }

    private async handleLine(line: string, transport: Transport): Promise<void> {
        let req: RpcRequest;
        try {
            req = JSON.parse(line) as RpcRequest;
        } catch {
            transport.send({
                jsonrpc: "2.0",
                id: null,
                error: { code: RpcErrorCode.PARSE_ERROR, message: "Parse error" },
            });
            return;
        }
        try {
            await this.ready;
            const result = await this.dispatch(req, transport);
            if (req.id !== undefined) {
                transport.send({ jsonrpc: "2.0", id: req.id, result });
            }
        } catch (err) {
            if (req.id !== undefined) {
                transport.send({
                    jsonrpc: "2.0",
                    id: req.id,
                    error: { code: RpcErrorCode.INTERNAL_ERROR, message: (err as Error).message },
                });
            }
        }
    }

    private async dispatch(req: RpcRequest, transport: Transport): Promise<unknown> {
        const params = (req.params ?? {}) as Record<string, unknown>;
        switch (req.method) {
            case "session.create": {
                const cwd = String(params.cwd ?? process.cwd());
                const provider = (params.provider as ProviderId) ?? getActiveProvider() ?? "xai";
                const model = String(params.model ?? "");
                const session = await this.manager.create({ cwd, provider, model });
                const ctx: ActiveSession = {
                    session,
                    tracker: new CostTracker(),
                    abort: new AbortController(),
                    emitter: new EventEmitter(),
                    modelId: model,
                    running: false,
                    subscribers: new Set([transport]),
                    seq: 0,
                    ring: [],
                };
                this.wireCtx(session.id, ctx);
                this.sessions.set(session.id, ctx);
                return { sessionId: session.id };
            }
            case "session.list": {
                // DB rows enriched with liveness so pickers can mark sessions
                // that are running / being watched right now.
                return this.manager.list(params.cwd as string | undefined).map((row) => {
                    const ctx = this.sessions.get(row.id);
                    return { ...row, running: ctx?.running ?? false, attached: ctx?.subscribers.size ?? 0 };
                });
            }
            case "session.history": {
                // Full transcript along the current branch so a (re)connecting
                // client can render the conversation before subscribing to the
                // live stream. Abandoned branches are excluded — this is what
                // the model sees. Returns the current event seq so the client
                // can session.attach {afterSeq} without a gap.
                const id = String(params.sessionId);
                const ctx = await this.ensureCtx(id);
                return {
                    sessionId: id,
                    info: ctx.session.info,
                    name: ctx.session.getName(),
                    leafId: ctx.session.getLeafId(),
                    entries: ctx.session.getBranch(),
                    seq: ctx.seq,
                    running: ctx.running,
                };
            }
            case "session.open": {
                // Reuses a live context: a second client opening the session
                // must NOT reset the running flag / abort controller of a turn
                // in flight. Does NOT subscribe — clients call session.attach
                // after rendering history, so no event can slip in between and
                // apply twice (or out of order).
                const id = String(params.sessionId);
                const ctx = await this.ensureCtx(id);
                return { sessionId: id, info: ctx.session.info, running: ctx.running, seq: ctx.seq };
            }
            case "session.attach": {
                // Subscribe + catch up: replays ring events after `afterSeq`,
                // or signals resync when the gap left the ring (client falls
                // back to a full session.history render).
                const id = String(params.sessionId);
                const ctx = await this.ensureCtx(id);
                ctx.subscribers.add(transport);
                const afterSeq = params.afterSeq === undefined ? undefined : Number(params.afterSeq);
                let resync = false;
                if (afterSeq !== undefined && afterSeq < ctx.seq) {
                    const oldest = ctx.ring.length ? ctx.ring[0].seq : ctx.seq + 1;
                    if (afterSeq < oldest - 1) {
                        resync = true;
                    } else {
                        for (const entry of ctx.ring) {
                            if (entry.seq > afterSeq) {
                                transport.send({
                                    jsonrpc: "2.0",
                                    method: "session.event",
                                    params: { sessionId: id, seq: entry.seq, part: entry.part },
                                });
                            }
                        }
                    }
                } else if (afterSeq !== undefined && afterSeq > ctx.seq) {
                    // Client is ahead of us: the server restarted and the seq
                    // counter reset. Its transcript is stale — full resync.
                    resync = true;
                }
                return { ok: true, seq: ctx.seq, running: ctx.running, resync };
            }
            case "session.detach": {
                const id = String(params.sessionId);
                this.sessions.get(id)?.subscribers.delete(transport);
                return { ok: true };
            }
            case "session.send": {
                const id = String(params.sessionId);
                const ctx = this.requireSession(id);
                if (ctx.running) throw new Error(`session ${id} already has a turn running (cancel it first)`);
                // Remote clients (web UI) attach images as base64 payloads: each
                // is written to a temp file and referenced with the same
                // [image:<path>] sentinel paste/drag produces in the TUI, so the
                // whole existing pipeline (extraction, transcript, replay)
                // applies unchanged.
                const input = String(params.input ?? "") + writeImagePayloads(params.images);
                const modelId = String(params.model ?? ctx.modelId);
                // Per-send thinking override; anything unknown falls back to the
                // thinkingLevel setting (runTurn's own default).
                const thinking = THINKING_LEVELS.includes(params.thinking as ThinkingLevel)
                    ? (params.thinking as ThinkingLevel)
                    : undefined;
                ctx.modelId = modelId;
                ctx.running = true;
                // run async; events stream via notifications
                runTurn({
                    session: ctx.session,
                    modelId,
                    userInput: input,
                    cwd: ctx.session.info.cwd,
                    abortSignal: ctx.abort.signal,
                    tracker: ctx.tracker,
                    emitter: ctx.emitter,
                    thinkingLevel: thinking,
                })
                    .catch((err) => {
                        // Same channel + shape as the emitter's "error" event, so a
                        // client has one error path to handle, not two. Broadcast
                        // (not just the sender): every watcher needs the turn end.
                        this.broadcast(id, ctx, { type: "error", data: String(err) });
                    })
                    .finally(() => {
                        ctx.running = false;
                    });
                return { ok: true };
            }
            case "session.rename": {
                const id = String(params.sessionId);
                const ctx = this.requireSession(id);
                const name = String(params.name ?? "").trim();
                await ctx.session.setName(name);
                return { ok: true, name };
            }
            case "session.cancel": {
                const id = String(params.sessionId);
                const ctx = this.requireSession(id);
                ctx.abort.abort();
                ctx.abort = new AbortController();
                return { ok: true };
            }
            case "session.compact": {
                const id = String(params.sessionId);
                const ctx = this.requireSession(id);
                if (ctx.running) throw new Error(`session ${id} already has a turn running (cancel it first)`);
                ctx.running = true;
                try {
                    return await runCompact({
                        session: ctx.session,
                        modelId: ctx.modelId,
                        keepTurns: 0,
                        tracker: ctx.tracker,
                        cwd: ctx.session.info.cwd,
                    });
                } finally {
                    ctx.running = false;
                }
            }
            case "auth.status":
                // `providers` is what a remote client may OFFER, which includes
                // the zero-login (ollama, bedrock) and custom gateways that have
                // no auth entry — returning only logged-in providers here is
                // what made them vanish from the Telegram and web pickers.
                // `authorized` keeps the strict "has stored credentials" set.
                return {
                    providers: await listUsableProviders(),
                    authorized: listAuthorizedProviders(),
                    active: getActiveProvider(),
                };
            case "auth.login": {
                const provider = params.provider as ProviderId;
                const key = String(params.apiKey ?? "");
                if (!provider || !key) {
                    throw new Error("provider and apiKey required");
                }
                loginApiKey(provider, key);
                return { ok: true };
            }
            case "catalog.list": {
                const cat = await getCatalog();
                const wanted = params.provider as ProviderId | undefined;
                const list = Object.values(cat);
                return wanted ? list.filter((m) => m.provider === wanted) : list;
            }
            case "cost.session": {
                const id = String(params.sessionId);
                const ctx = this.requireSession(id);
                return ctx.tracker.sessionBreakdown();
            }
            case "cost.lifetime": {
                const tracker = new CostTracker();
                return tracker.lifetimeBreakdown();
            }
            case "cost.stats": {
                // today/7d/month/lifetime USD + per-provider split; cwd bucket
                // when the client passes one (the web UI's selected project).
                const tracker = new CostTracker();
                return tracker.stats(params.cwd ? String(params.cwd) : undefined);
            }
            case "usage.steak": {
                // The /steak heatmap, computed server-side with the exact CLI
                // layout (buildSteakGrid) so every client shades identically.
                const year = params.year !== undefined ? Number(params.year) : undefined;
                const daily = this.manager.dailyTokens();
                return buildSteakGrid(daily, Number.isInteger(year) ? { year } : {});
            }
            case "settings.list": {
                return WEB_SETTINGS.map((s) => ({
                    key: s.key,
                    label: s.label,
                    description: s.description,
                    value: (getSetting(s.key) as boolean | undefined) ?? s.def,
                }));
            }
            case "context.report": {
                // The /context breakdown for an open session, or — for a draft
                // (no session yet) — the fixed overhead a new session in that
                // cwd would start with. Read-only; buildContextReport mutates
                // nothing.
                if (params.sessionId) {
                    const ctx = await this.ensureCtx(String(params.sessionId));
                    return buildContextReport({
                        session: ctx.session,
                        modelId: ctx.modelId,
                        cwd: ctx.session.info.cwd,
                    });
                }
                const model = String(params.model ?? getSetting("defaultModel") ?? "");
                return buildContextReport({
                    session: null,
                    modelId: model,
                    cwd: String(params.cwd ?? process.cwd()),
                });
            }
            case "extension.list": {
                return getExtensionHost().listAll();
            }
            case "extension.setEnabled": {
                // Enable/disable only — install/uninstall stay local-only, a
                // remote client must not be able to pull new code onto the box.
                const name = String(params.name ?? "");
                if (typeof params.value !== "boolean") throw new Error("value must be boolean");
                const entry = getExtensionHost()
                    .listAll()
                    .find((e) => e.name === name);
                if (!entry) throw new Error(`unknown extension: ${name}`);
                if (entry.builtin) setBuiltinEnabled(name, params.value);
                else setRecordEnabled(name, params.value);
                const host = getExtensionHost();
                if (params.value) await host.reload(name);
                else await host.unload(name);
                bustCatalogCache();
                return { name, value: params.value };
            }
            case "settings.set": {
                const key = String(params.key);
                const entry = WEB_SETTINGS.find((s) => s.key === key);
                if (!entry) throw new Error(`setting not writable over RPC: ${key}`);
                if (typeof params.value !== "boolean") throw new Error("value must be boolean");
                setSetting(entry.key, params.value as never);
                return { key, value: params.value };
            }
            case "server.info": {
                // Capabilities handshake: lets a client discover the methods and
                // event types this server speaks without version-sniffing.
                // `defaults` saves a remote client (which has no local settings)
                // from guessing a model/cwd for session.create.
                return {
                    protocol: "2.0",
                    methods: RPC_METHODS,
                    events: TURN_EVENT_NAMES,
                    defaults: {
                        model: getSetting("defaultModel") ?? null,
                        cwd: process.cwd(),
                    },
                };
            }
            default:
                throw new Error(`Method not found: ${req.method}`);
        }
    }

    private requireSession(id: string): ActiveSession {
        const ctx = this.sessions.get(id);
        if (!ctx) throw new Error(`Unknown sessionId: ${id}`);
        return ctx;
    }

    /** Live context for a session, loading it from the store on first touch.
     * Reuse is the point: a reload/second client must see the same running
     * flag, abort controller, and event ring as the turn already in flight. */
    private async ensureCtx(id: string): Promise<ActiveSession> {
        const existing = this.sessions.get(id);
        if (existing) return existing;
        const session = await this.manager.open(id);
        const ctx: ActiveSession = {
            session,
            tracker: new CostTracker(),
            abort: new AbortController(),
            emitter: new EventEmitter(),
            modelId: session.info.model,
            running: false,
            subscribers: new Set(),
            seq: 0,
            ring: [],
        };
        this.wireCtx(id, ctx);
        this.sessions.set(id, ctx);
        return ctx;
    }

    /** Stamp a seq, remember for replay, fan out to every subscriber. */
    private broadcast(sessionId: string, ctx: ActiveSession, part: { type: string; data: unknown }): void {
        const seq = ++ctx.seq;
        ctx.ring.push({ seq, part });
        if (ctx.ring.length > EVENT_RING_SIZE) ctx.ring.shift();
        for (const sub of ctx.subscribers) {
            sub.send({
                jsonrpc: "2.0",
                method: "session.event",
                params: { sessionId, seq, part },
            });
        }
    }

    private wireCtx(sessionId: string, ctx: ActiveSession): void {
        // Forward the ENTIRE turn stream — reasoning, tool lifecycle, subagents,
        // step usage, recap — not a hand-picked subset. TURN_EVENT_NAMES is the
        // single source of truth: a new event on the agent loop reaches clients
        // automatically (and can't be forgotten — the list is build-checked).
        for (const event of TURN_EVENT_NAMES) {
            ctx.emitter.on(event, (data: unknown) => {
                this.broadcast(sessionId, ctx, { type: event, data });
            });
        }
    }
}

const IMAGE_EXT_BY_TYPE: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
};
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Persist base64 image payloads to temp files; returns "[image:…]" sentinels
 * to append to the input (empty string when there is nothing valid).
 * Exported for tests. */
export function writeImagePayloads(raw: unknown): string {
    if (!Array.isArray(raw) || raw.length === 0) return "";
    let out = "";
    for (const item of raw.slice(0, MAX_IMAGES)) {
        const img = item as { data?: unknown; mediaType?: unknown };
        const ext = IMAGE_EXT_BY_TYPE[String(img.mediaType ?? "")];
        if (!ext || typeof img.data !== "string") continue;
        const bytes = Buffer.from(img.data, "base64");
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) continue;
        const path = join(tmpdir(), `${PRODUCT_NAME}-attach-${randomBytes(8).toString("hex")}.${ext}`);
        writeFileSync(path, bytes);
        out += `\n[image:${path}]`;
    }
    return out;
}

export function startStdioServer(): void {
    const server = new RpcServer();
    const transport: Transport = {
        send(msg) {
            process.stdout.write(JSON.stringify(msg) + "\n");
        },
    };
    const { feed } = server.attach(transport);
    process.stdin.on("data", feed);
    process.stdin.on("end", () => process.exit(0));
}

function rpcPaths(): { socketPath: string; pidPath: string } {
    const dir = join(getConfigDir(), "agent");
    mkdirSync(dir, { recursive: true });
    return { socketPath: join(dir, "rpc.sock"), pidPath: join(dir, "rpc.pid") };
}

/** Pid from rpc.pid if that process is still alive, else null (stale/absent). */
function liveDaemonPid(pidPath: string): number | null {
    if (!existsSync(pidPath)) return null;
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        process.kill(pid, 0); // signal 0 = existence check only
        return pid;
    } catch {
        return null;
    }
}

export function startSocketServer(): { server: Server; socketPath: string; pidPath: string } {
    const { socketPath, pidPath } = rpcPaths();
    const alive = liveDaemonPid(pidPath);
    if (alive)
        throw new Error(
            `${PRODUCT_NAME} rpc daemon already running (pid ${alive}); stop it with: ${PRODUCT_NAME} rpc stop`,
        );
    // Any leftover socket belongs to a dead daemon (the pid check above).
    if (existsSync(socketPath)) unlinkSync(socketPath);

    const server = new RpcServer();
    const net = createServer((socket: Socket) => {
        const transport: Transport = {
            send(msg) {
                socket.write(JSON.stringify(msg) + "\n");
            },
        };
        const { feed, close } = server.attach(transport);
        socket.on("data", feed);
        socket.on("close", close);
        socket.on("error", () => socket.destroy());
    });

    net.listen(socketPath, () => {
        writeFileSync(pidPath, String(process.pid));
    });

    // Leave no stale socket/pid behind on a signal exit — the next start would
    // otherwise have to clean up after us.
    const shutdown = () => {
        try {
            unlinkSync(socketPath);
        } catch {}
        try {
            unlinkSync(pidPath);
        } catch {}
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    return { server: net, socketPath, pidPath };
}

/**
 * Stop a running socket daemon via its pid file (SIGTERM — the daemon's own
 * handler cleans up its socket/pid). Returns what happened for the CLI to
 * report; stale files from a dead daemon are cleaned up here.
 */
export function stopSocketServer(): { stopped: boolean; pid?: number } {
    const { socketPath, pidPath } = rpcPaths();
    const pid = liveDaemonPid(pidPath);
    if (!pid) {
        try {
            unlinkSync(socketPath);
        } catch {}
        try {
            unlinkSync(pidPath);
        } catch {}
        return { stopped: false };
    }
    process.kill(pid, "SIGTERM");
    return { stopped: true, pid };
}
