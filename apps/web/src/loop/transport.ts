/**
 * The single seam between this UI and loop.
 *
 * Everything the app knows about loop goes through `loopCall` — one JSON-RPC
 * request/response — and `onLoopEvent` — loop's `session.event` notifications.
 * Nothing above this file speaks WebSocket, and nothing below it knows what a
 * thread or a project is.
 *
 * Two shells run the same UI:
 *
 *   - `loop serve`: one WebSocket to the server.
 *   - Electron: one `loop rpc` child, spoken to over the preload bridge.
 *
 * In both, `cwd` rides as a call parameter rather than selecting a backend:
 * loop's sessions carry their own cwd, so a single agent process serves every
 * project (see apps/desktop/src/loopProcess.ts).
 *
 * The Electron bridge is injected on `window.loop` by the preload script; when
 * it is absent we are in a browser and take the socket path.
 */

export interface LoopEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly part: unknown;
}

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export type ReadWorkspaceFileResult =
  | {
      readonly ok: true;
      readonly relativePath: string;
      readonly contents: string;
      readonly byteLength: number;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly failure: string };

/**
 * Filesystem access, which only the desktop shell has.
 *
 * loop speaks an agent protocol with no file operations, and a browser has no
 * filesystem, so this is the one capability that genuinely differs between the
 * two shells rather than merely being routed differently.
 */
export interface LoopFilesystemBridge {
  list(cwd: string): Promise<{ entries: readonly WorkspaceEntry[]; truncated: boolean }>;
  read(cwd: string, relativePath: string): Promise<ReadWorkspaceFileResult>;
  browse(
    partialPath: string,
    cwd: string | undefined,
  ): Promise<{ parentPath: string; entries: readonly { name: string; fullPath: string }[] } | null>;
}

export interface TerminalSnapshot {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly status: "starting" | "running" | "exited" | "error";
  readonly pid: number | null;
  readonly history: string;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly label: string;
  readonly updatedAt: string;
}

export interface TerminalOutput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly type: "output" | "exited" | "closed";
  readonly data?: string;
  readonly exitCode?: number | null;
  readonly exitSignal?: number | null;
}

/** PTYs, which like the filesystem only the desktop shell can provide. */
export interface LoopPtyBridge {
  open(input: {
    threadId: string;
    terminalId: string;
    cwd: string;
    worktreePath?: string | null;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  }): Promise<TerminalSnapshot>;
  snapshot(threadId: string, terminalId: string): Promise<TerminalSnapshot | null>;
  write(threadId: string, terminalId: string, data: string): Promise<void>;
  resize(threadId: string, terminalId: string, cols: number, rows: number): Promise<void>;
  clear(threadId: string, terminalId: string): Promise<void>;
  close(threadId: string, terminalId: string | undefined): Promise<void>;
  onOutput(listener: (event: TerminalOutput) => void): () => void;
}

export interface GitRef {
  readonly name: string;
  readonly isRemote: boolean;
  readonly remoteName?: string;
  readonly current: boolean;
  readonly isDefault: boolean;
  readonly worktreePath: string | null;
}

export interface GitStatus {
  readonly isRepo: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly isDefaultRef: boolean;
  readonly refName: string | null;
  readonly hasWorkingTreeChanges: boolean;
  readonly workingTree: {
    readonly files: ReadonlyArray<{ path: string; insertions: number; deletions: number }>;
    readonly insertions: number;
    readonly deletions: number;
  };
  readonly hasUpstream: boolean;
  readonly aheadCount: number;
  readonly behindCount: number;
}

/** Read-only git, from the shell. Writing is the agent's job, not the UI's. */
export interface LoopGitBridge {
  refs(cwd: string): Promise<{
    refs: readonly GitRef[];
    isRepo: boolean;
    hasPrimaryRemote: boolean;
    totalCount: number;
  }>;
  status(cwd: string): Promise<GitStatus>;
}

/** The preload bridge. Kept structural so the renderer needs no Electron types. */
interface LoopDesktopBridge {
  call(method: string, params: unknown, cwd: string | undefined): Promise<unknown>;
  onEvent(listener: (event: LoopEvent) => void): () => void;
  /** Folder-less calls route here. */
  anchorCwd(): Promise<string | undefined>;
  fs?: LoopFilesystemBridge;
  pty?: LoopPtyBridge;
  git?: LoopGitBridge;
}

declare global {
  interface Window {
    loop?: LoopDesktopBridge;
  }
}

export class LoopTransportError extends Error {
  readonly method: string;
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = "LoopTransportError";
    this.method = method;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ConnectionState = "connecting" | "open" | "closed";

/**
 * Where `loop serve` is. Same origin is the shipped case — the page is served
 * by loop itself. `?rpc=` / `VITE_LOOP_RPC_URL` exist so `vp dev` on :5733 can
 * drive a `loop serve` on :5667.
 */
function resolveSocketUrl(): string {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const override = params.get("rpc") ?? (import.meta.env?.VITE_LOOP_RPC_URL as string | undefined);
  const token = params.get("token") ?? "";
  const base =
    override ??
    `${globalThis.location.protocol === "https:" ? "wss:" : "ws:"}//${globalThis.location.host}/ws`;
  if (!token) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

class LoopSocket {
  #socket: WebSocket | null = null;
  #state: ConnectionState = "closed";
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: LoopEvent) => void>();
  #stateListeners = new Set<(state: ConnectionState) => void>();
  #reconnectDelay = RECONNECT_MIN_MS;
  /** Calls made before the socket opens wait here rather than failing. */
  #openWaiters: Array<() => void> = [];

  get state(): ConnectionState {
    return this.#state;
  }

  connect(): void {
    if (this.#state !== "closed") return;
    this.#setState("connecting");
    const socket = new WebSocket(resolveSocketUrl());
    this.#socket = socket;
    socket.onopen = () => {
      this.#reconnectDelay = RECONNECT_MIN_MS;
      this.#setState("open");
      const waiters = this.#openWaiters;
      this.#openWaiters = [];
      for (const wake of waiters) wake();
    };
    socket.onmessage = (event) => this.#receive(String(event.data));
    socket.onclose = () => this.#handleClose();
    socket.onerror = () => socket.close();
  }

  onEvent(listener: (event: LoopEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async call(method: string, params: unknown): Promise<unknown> {
    this.connect();
    if (this.#state === "connecting") await this.#awaitOpen();
    const socket = this.#socket;
    if (!socket || this.#state !== "open") {
      throw new LoopTransportError(method, "not connected to loop");
    }
    const id = this.#nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new LoopTransportError(method, "timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  #awaitOpen(): Promise<void> {
    return new Promise((resolve) => {
      this.#openWaiters.push(resolve);
      setTimeout(resolve, REQUEST_TIMEOUT_MS);
    });
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }

  #receive(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "loop rpc error"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "session.event") {
      const event = message.params as LoopEvent;
      for (const listener of this.#listeners) listener(event);
    }
  }

  #handleClose(): void {
    this.#socket = null;
    this.#setState("closed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("connection to loop closed"));
    }
    this.#pending.clear();
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    setTimeout(() => this.connect(), delay);
  }
}

const socket = new LoopSocket();

/** True when running inside the Electron shell rather than a browser. */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && window.loop !== undefined;
}

/**
 * One loop JSON-RPC call.
 *
 * `cwd` identifies the project. Over `loop serve` it is a filter the server
 * applies; in Electron it selects which `loop rpc` process answers.
 */
export async function loopCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  cwd?: string,
): Promise<T> {
  const bridge = typeof window !== "undefined" ? window.loop : undefined;
  if (bridge) return (await bridge.call(method, params, cwd)) as T;
  // Over a socket the server holds every cwd, so the folder rides along as a
  // parameter instead of picking a process.
  const withCwd = cwd === undefined ? params : { cwd, ...params };
  return (await socket.call(method, withCwd)) as T;
}

/** Subscribe to loop's `session.event` notifications. Returns an unsubscribe. */
export function onLoopEvent(listener: (event: LoopEvent) => void): () => void {
  const bridge = typeof window !== "undefined" ? window.loop : undefined;
  if (bridge) return bridge.onEvent(listener);
  socket.connect();
  return socket.onEvent(listener);
}

/** Connection state, for the shells that show a disconnected banner. */
export function onLoopConnectionChange(listener: (state: ConnectionState) => void): () => void {
  if (isDesktopShell()) return () => {};
  return socket.onStateChange(listener);
}

/** Open the connection eagerly so the first call does not pay for the handshake. */
export function connectToLoop(): void {
  if (!isDesktopShell()) socket.connect();
}

/**
 * The filesystem bridge, or null in a browser.
 *
 * Returning null rather than a stub is deliberate: a caller has to decide what
 * "no filesystem here" means for its feature, and a stub that answers with an
 * empty directory would make an unavailable capability look like an empty
 * project.
 */
export function loopFilesystem(): LoopFilesystemBridge | null {
  return (typeof window !== "undefined" ? window.loop?.fs : undefined) ?? null;
}

/** The PTY bridge, or null in a browser. See loopFilesystem for the rationale. */
export function loopPty(): LoopPtyBridge | null {
  return (typeof window !== "undefined" ? window.loop?.pty : undefined) ?? null;
}

/** The git bridge, or null in a browser. See loopFilesystem for the rationale. */
export function loopGit(): LoopGitBridge | null {
  return (typeof window !== "undefined" ? window.loop?.git : undefined) ?? null;
}
