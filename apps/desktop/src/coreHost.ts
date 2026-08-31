/**
 * loop's core, running inside this process.
 *
 * The alternative — and what this replaces — is `LoopProcess`: spawn the
 * compiled `loop rpc` binary and talk JSON-RPC over its stdio. That works, but
 * it makes every new capability cost a wire protocol: a method name, a
 * dispatch case, an entry in `server.info`, a guard for the case where the
 * installed binary predates the app. Core is a library; the main process is
 * Node; there is no reason for a child process to sit between them.
 *
 * **The renderer is still Chromium and still cannot import core** — so
 * `window.loop.call(method, params)` stays exactly as it was, and only what
 * answers it changes. Nothing in the renderer knows the difference.
 *
 * The swap is deliberately minimal rather than clever. `RpcServer.attach()`
 * takes a transport that is only `{ send(msg) }` and hands back a `feed()`
 * that accepts newline-delimited JSON — so the same dispatch that served the
 * socket now serves this, byte for byte, with the pipe removed. That is why
 * all 48 existing methods work on day one with no per-method porting: the
 * request path is unchanged, it just no longer leaves the process.
 *
 * New capabilities do NOT have to go through that path. `CoreHost` is the
 * place to add direct core calls, which is the whole point of the change: a
 * feature becomes a function call, not a protocol.
 *
 * **Imported from `@notshekhar/loop-core/embed`, never the package root.** The
 * root barrel re-exports `./datasources`, whose `import { SQL } from "bun"` is
 * a TOP-LEVEL import — evaluated on load, and fatal under Node, which has no
 * `bun` module. The embed entry point is `rpc/server.ts` directly, which does
 * not reach it. (It also resolves to core's SOURCE rather than its prebuilt
 * `dist`, so the shell can never bundle a stale core.)
 */
import { EventEmitter } from "node:events";

import { createDirectHandlers, type DirectHandler } from "./coreDirect.js";
import { RpcServer } from "@notshekhar/loop-core/embed";

/** A JSON-RPC message coming back out of core. */
interface CoreMessage {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export declare interface CoreHost {
  on(event: "notification", listener: (message: { method: string; params: unknown }) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
  /** Never emitted — in-process core cannot exit on its own. Declared so the
   * main process can listen to a CoreHost and a LoopProcess identically. */
  on(event: "exit", listener: (code: number | null) => void): this;
}

export class CoreHost extends EventEmitter {
  #server: RpcServer | null = null;
  #feed: ((chunk: string) => void) | null = null;
  #close: (() => void) | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #direct: Record<string, DirectHandler> = {};
  readonly #cwd: string;

  constructor(options: { cwd: string }) {
    super();
    this.#cwd = options.cwd;
  }

  get running(): boolean {
    return this.#server !== null;
  }

  /** Which loop is answering, for the startup log that names the binary. */
  get description(): string {
    return "in-process core";
  }

  start(): void {
    if (this.#server) return;
    // Core reads process.cwd() only as a default for calls that omit `cwd`
    // (session.create, context.report). Sessions carry their own, so this is
    // the anchor folder and nothing more — same contract LoopProcess had.
    try {
      process.chdir(this.#cwd);
    } catch (error) {
      // A missing anchor directory must not stop the app booting; calls that
      // pass an explicit cwd are unaffected.
      this.emit("stderr", `could not enter ${this.#cwd}: ${(error as Error).message}`);
    }

    const server = new RpcServer();
    const attached = server.attach({
      send: (message) => this.#receive(message as CoreMessage),
    });
    this.#server = server;
    this.#feed = attached.feed;
    this.#close = attached.close;
    this.#direct = createDirectHandlers();
  }

  /** Everything answered without going through core's RPC dispatch. */
  get directMethods(): readonly string[] {
    return Object.keys(this.#direct);
  }

  stop(): void {
    // Core runs IN THIS PROCESS, so a background shell it started is a child
    // of the Electron main process — and a detached one survives the app
    // quitting. Nothing else reaps them: `LoopProcess.stop()` at least kills a
    // child that now cleans up after itself on SIGTERM, but embedded core has
    // no such boundary. dispose() is that boundary.
    this.#server?.dispose();
    this.#close?.();
    this.#close = null;
    this.#feed = null;
    this.#server = null;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("core stopped"));
    }
    this.#pending.clear();
  }

  async call(method: string, params: unknown): Promise<unknown> {
    // Direct handlers first, so a capability that needs no protocol never
    // acquires one. See coreDirect.ts.
    const direct = this.#direct[method];
    if (direct) {
      // Awaited inside this async function so a handler that throws
      // synchronously rejects the promise rather than blowing up the caller.
      return await direct((params ?? {}) as Record<string, unknown>);
    }
    const feed = this.#feed;
    if (!feed) throw new Error("core is not running");
    const id = this.#nextId++;
    return await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      // Newline-delimited JSON because that is what `attach()` parses. The
      // round trip through a string is a few microseconds and buys an exactly
      // identical code path to the socket server — worth far more than saving
      // it, since any divergence here would be a bug only the desktop sees.
      try {
        feed(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #receive(message: CoreMessage): void {
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "core rpc error"));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      this.emit("notification", { method: message.method, params: message.params });
    }
  }
}
