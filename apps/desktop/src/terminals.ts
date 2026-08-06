/**
 * Real PTYs for the terminal panel.
 *
 * Like the filesystem, this lives in the shell rather than in loop: loop's RPC
 * is an agent protocol and has no terminal, and a browser cannot fork a shell.
 *
 * Terminal ids are chosen by the renderer and sent explicitly — the contract is
 * emphatic that there is no server-side allocation — so this is a plain map
 * keyed by `threadId:terminalId`, and reopening an id that already exists
 * attaches to the running process instead of starting a second one.
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import * as pty from "node-pty";

/** Enough scrollback to restore a useful screen on reattach, bounded. */
const MAX_HISTORY_CHARS = 256 * 1024;

export interface TerminalSnapshot {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  /** Mirrors the contract's TerminalSessionStatus, which has no "closed". */
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

interface Session {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly process: pty.IPty;
  history: string;
  status: "running" | "exited";
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
}

const key = (threadId: string, terminalId: string) => `${threadId}:${terminalId}`;

/** The user's login shell, so aliases and prompt match their terminal app. */
function defaultShell(): string {
  if (platform() === "win32") return process.env["COMSPEC"] ?? "powershell.exe";
  return process.env["SHELL"] ?? "/bin/zsh";
}

export declare interface TerminalManager {
  on(event: "output", listener: (event: TerminalOutput) => void): this;
}

export class TerminalManager extends EventEmitter {
  #sessions = new Map<string, Session>();

  /** Reattaches when the id is already live; starts a shell otherwise. */
  open(input: {
    threadId: string;
    terminalId: string;
    cwd: string;
    worktreePath?: string | null;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  }): TerminalSnapshot {
    const existing = this.#sessions.get(key(input.threadId, input.terminalId));
    if (existing && existing.status === "running") return snapshotOf(existing);

    // An unreachable cwd would make the spawn throw with a message that says
    // nothing useful; fall back so a terminal still opens.
    const cwd = existsSync(input.cwd) ? input.cwd : homedir();
    const shell = defaultShell();
    const child = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      cwd,
      env: { ...process.env, ...input.env, TERM: "xterm-256color" } as Record<string, string>,
    });

    const session: Session = {
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd,
      worktreePath: input.worktreePath ?? null,
      process: child,
      history: "",
      status: "running",
      exitCode: null,
      exitSignal: null,
      updatedAt: new Date().toISOString(),
    };
    this.#sessions.set(key(input.threadId, input.terminalId), session);

    child.onData((data) => {
      session.history = (session.history + data).slice(-MAX_HISTORY_CHARS);
      session.updatedAt = new Date().toISOString();
      this.emit("output", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        type: "output",
        data,
      });
    });

    child.onExit(({ exitCode, signal }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      session.exitSignal = signal ?? null;
      session.updatedAt = new Date().toISOString();
      this.emit("output", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        type: "exited",
        exitCode,
        exitSignal: signal ?? null,
      });
    });

    return snapshotOf(session);
  }

  snapshot(threadId: string, terminalId: string): TerminalSnapshot | null {
    const session = this.#sessions.get(key(threadId, terminalId));
    return session ? snapshotOf(session) : null;
  }

  write(threadId: string, terminalId: string, data: string): void {
    this.#sessions.get(key(threadId, terminalId))?.process.write(data);
  }

  resize(threadId: string, terminalId: string, cols: number, rows: number): void {
    const session = this.#sessions.get(key(threadId, terminalId));
    if (!session || session.status !== "running") return;
    // node-pty throws on a zero dimension, which a hidden panel can report.
    if (cols < 1 || rows < 1) return;
    session.process.resize(cols, rows);
  }

  clear(threadId: string, terminalId: string): void {
    const session = this.#sessions.get(key(threadId, terminalId));
    if (session) session.history = "";
  }

  /** Closes one terminal, or every terminal of a thread when the id is absent
   *  — which is what the contract means by an optional terminalId. */
  close(threadId: string, terminalId?: string): void {
    const targets =
      terminalId === undefined
        ? [...this.#sessions.values()].filter((session) => session.threadId === threadId)
        : [this.#sessions.get(key(threadId, terminalId))].filter((s): s is Session => s !== undefined);

    for (const session of targets) {
      this.#sessions.delete(key(session.threadId, session.terminalId));
      if (session.status === "running") session.process.kill();
      this.emit("output", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        type: "closed",
      });
    }
  }

  /** Kills everything; called when the window goes away. */
  closeAll(): void {
    for (const session of this.#sessions.values()) {
      if (session.status === "running") session.process.kill();
    }
    this.#sessions.clear();
  }
}

function snapshotOf(session: Session): TerminalSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.status === "running" ? session.process.pid : null,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: session.cwd.slice(session.cwd.lastIndexOf("/") + 1) || "terminal",
    updatedAt: session.updatedAt,
  };
}
