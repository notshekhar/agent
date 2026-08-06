/**
 * The `loop rpc` child process.
 *
 * `loop rpc` with no flags speaks the same JSON-RPC the WebSocket carries, one
 * JSON message per line, over stdin/stdout. So the desktop shell needs no
 * server, no port and no token: it spawns loop as a child and pipes to it.
 *
 * MEASURED, and it overturns the obvious design: **one process serves every
 * project**. `process.cwd()` appears in loop's RPC server only as a default for
 * callers that omit `cwd` (`session.create`, `context.report`) and in
 * `server.info`'s reported defaults. Sessions carry their own cwd, and
 * `session.send` reads it from the session rather than the process. Spawning
 * one loop per folder would multiply memory and startup for nothing.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where an installed loop lives, in the order worth trying. */
const LOOP_BINARY_CANDIDATES = [
  join(homedir(), ".loop-bin", "loop"),
  "/usr/local/bin/loop",
  "/opt/homebrew/bin/loop",
  join(homedir(), ".local", "bin", "loop"),
];

export function resolveLoopBinary(override?: string): string {
  if (override && existsSync(override)) return override;
  const found = LOOP_BINARY_CANDIDATES.find((candidate) => existsSync(candidate));
  // Falling back to the bare name lets PATH resolve it; if that fails too, the
  // spawn error surfaces with the name it tried rather than a silent hang.
  return found ?? "loop";
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export declare interface LoopProcess {
  on(event: "notification", listener: (message: { method: string; params: unknown }) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
}

export class LoopProcess extends EventEmitter {
  #child: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  /** stdout arrives in arbitrary chunks; messages are newline-delimited. */
  #buffer = "";
  readonly #binary: string;
  readonly #cwd: string;

  constructor(options: { binary: string; cwd: string }) {
    super();
    this.#binary = options.binary;
    this.#cwd = options.cwd;
  }

  get running(): boolean {
    return this.#child !== null;
  }

  start(): void {
    if (this.#child) return;
    const child = spawn(this.#binary, ["rpc"], {
      cwd: this.#cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.#child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim() !== "") this.emit("stderr", line);
    });

    const onGone = (code: number | null) => {
      this.#child = null;
      // Every caller waiting on this process has to be told, or the renderer
      // hangs on promises that can never settle.
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("loop exited"));
      }
      this.#pending.clear();
      this.emit("exit", code);
    };
    child.on("exit", onGone);
    child.on("error", (error) => {
      this.emit("stderr", `could not start ${this.#binary}: ${error.message}`);
      onGone(null);
    });
  }

  stop(): void {
    this.#child?.kill();
    this.#child = null;
  }

  call(method: string, params: unknown): Promise<unknown> {
    const child = this.#child;
    if (!child) return Promise.reject(new Error("loop is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== "") this.#dispatch(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #dispatch(line: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      // loop writes only JSON on stdout; anything else is a symptom worth
      // seeing rather than a message worth dropping silently.
      this.emit("stderr", `unparseable line from loop: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "loop rpc error"));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      this.emit("notification", { method: message.method, params: message.params });
    }
  }
}
