/**
 * Main's handle on the workspace host.
 *
 * Keeps the child alive, turns `call()` into a request/response round trip, and
 * re-emits everything the host produces on its own. Main is a pipe here: it
 * forwards notifications to the renderer by the channel the host names, so a
 * new host capability costs a line in `hostHandlers.ts` and nothing here.
 *
 * The host is restarted if it dies, because losing it must not cost the window.
 * What it cannot do is resurrect the terminals that died with it — the shells
 * were that process's children. Callers are told, rather than left waiting on a
 * reply that is never coming.
 */
import { EventEmitter } from "node:events";

import type { FromHost, HostCallback, HostNotification, ToHost } from "./hostProtocol.js";

/** Just enough of Electron's UtilityProcess for this module, so a test can fake it. */
export interface HostProcess {
  /** `transfer` carries MessagePortMains; typed loosely so a test can fake it. */
  postMessage(message: ToHost, transfer?: readonly unknown[]): void;
  kill(): boolean;
  on(event: "message", listener: (message: FromHost) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  readonly stderr?: { on(event: "data", listener: (chunk: unknown) => void): void } | null;
}

export type HostSpawner = () => HostProcess;

export declare interface HostClient {
  /** Something the host produced, addressed to a renderer channel. */
  on(event: "notify", listener: (message: HostNotification) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
  /** The host died. Terminals died with it. */
  on(event: "lost", listener: () => void): this;
  /**
   * A host is up and can be given things — a fresh one after a restart, too.
   * The direct terminal port is re-sent on this, because the old host took the
   * previous one to the grave with it.
   */
  on(event: "ready", listener: () => void): this;
}

export class HostClient extends EventEmitter {
  #process: HostProcess | null = null;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #spawn: HostSpawner;
  /** What main answers when the host asks it something. See HOST_CALLBACKS. */
  readonly #callbacks: Record<string, (params: unknown) => Promise<unknown>>;
  #stopped = false;

  constructor(
    spawn: HostSpawner,
    callbacks: Record<string, (params: unknown) => Promise<unknown>> = {},
  ) {
    super();
    this.#spawn = spawn;
    this.#callbacks = callbacks;
  }

  get running(): boolean {
    return this.#process !== null;
  }

  start(): void {
    if (this.#process || this.#stopped) return;
    const child = this.#spawn();
    this.#process = child;

    child.on("message", (message) => this.#receive(message));
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (text !== "") this.emit("stderr", text);
    });
    child.on("exit", (code) => {
      if (this.#process !== child) return;
      this.#process = null;
      // Every in-flight call is now unanswerable; failing them is the only
      // honest option, and far better than a UI that waits forever.
      this.#failAll(new Error(`the workspace host exited with ${code}`));
      this.emit("lost");
      if (this.#stopped) return;
      this.emit("stderr", `workspace host exited with ${code}; restarting`);
      setTimeout(() => this.start(), 500);
    });

    // After the listeners, so anything wired on "ready" can post to the child
    // immediately and know its reply will be heard.
    this.emit("ready");
  }

  /**
   * Hand the host one end of a pipe to somewhere else — today, the renderer.
   *
   * Separate from `call` because there is no reply: the port IS the message,
   * and what comes back comes back on the port rather than to main.
   */
  transferPort(port: unknown): void {
    this.#process?.postMessage({ kind: "port" }, [port]);
  }

  stop(): void {
    this.#stopped = true;
    const child = this.#process;
    this.#process = null;
    child?.kill();
    this.#failAll(new Error("the workspace host was stopped"));
  }

  async call(method: string, params: unknown = {}): Promise<unknown> {
    const child = this.#process;
    if (!child) throw new Error("the workspace host is not running");
    const id = this.#nextId++;
    return await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        child.postMessage({ kind: "request", id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #receive(message: FromHost): void {
    if (message.kind === "notify") {
      this.emit("notify", message);
      return;
    }
    if (message.kind === "callback") {
      void this.#answer(message);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error ?? "the workspace host failed"));
  }

  async #answer(message: HostCallback): Promise<void> {
    const child = this.#process;
    if (!child) return;
    const handler = this.#callbacks[message.method];
    try {
      if (!handler) throw new Error(`main cannot answer ${message.method}`);
      const value = await handler(message.params);
      child.postMessage({ kind: "callbackResponse", id: message.id, ok: true, value });
    } catch (error) {
      child.postMessage({
        kind: "callbackResponse",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
