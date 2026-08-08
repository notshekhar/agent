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

/**
 * How long `open` waits for the renderer to report the pane's real size before
 * starting the shell anyway.
 *
 * The renderer can only measure its surface once it has mounted, and a shell
 * inherits `COLUMNS` from the PTY it is born into — so starting one before the
 * size is known bakes in the wrong width (see `#start`). The grace period is
 * generous enough for a mount and short enough that a pane which never reports
 * a size still gets a working terminal.
 */
const SPAWN_SIZE_GRACE_MS = 750;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

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
  readonly type: "output" | "exited" | "closed" | "started";
  readonly data?: string;
  readonly exitCode?: number | null;
  readonly exitSignal?: number | null;
  /**
   * Present on `started`: the shell that has just been spawned.
   *
   * The renderer caches one attach stream per terminal id for minutes after its
   * last subscriber leaves, so a terminal reopened under a reused id wakes up
   * holding the DEAD session's scrollback and paints it before the new shell
   * says anything. Announcing the spawn lets that stream replace its buffer
   * outright instead of appending a second prompt below the ghost of the first.
   */
  readonly snapshot?: TerminalSnapshot;
}

interface Session {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env: Record<string, string>;
  /** Null until the shell is spawned — see SPAWN_SIZE_GRACE_MS. */
  process: PtyProcess | null;
  history: string;
  status: "starting" | "running" | "exited";
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  /** Anything written before the shell existed, replayed once it does. */
  pendingInput: string;
  /** Fires the spawn if no size ever arrives. */
  spawnTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Set by `close` before it kills the process.
   *
   * Killing a PTY makes it fire `onExit`, so a closed terminal reported BOTH
   * `closed` and, a tick later, `exited` — and the second one is an artifact of
   * the close, not a process that died on its own. It mattered because the
   * renderer caches an attach stream per terminal id and reopening reuses it:
   * the pane mounted, compared the cached `exited` against its initial
   * `closed`, concluded the shell had just died and closed its own surface. The
   * terminal appeared to open and vanish.
   */
  closing: boolean;
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

/**
 * Just enough of `pty.IPty` for this module, so a test can supply its own.
 *
 * node-pty spawns under Bun but never fires `onData`/`onExit` there (see
 * [[drover-pty-under-bun]]) — the callbacks only run in Electron's Node. A test
 * that drove a real shell would therefore assert on events that never arrive
 * and pass vacuously, which is exactly how the close/exit bug survived. So the
 * spawn is injectable and the lifecycle is tested against a fake.
 */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtySpawner = (input: {
  readonly shell: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Record<string, string>;
}) => PtyProcess;

const spawnRealPty: PtySpawner = (input) =>
  pty.spawn(input.shell, [], {
    name: "xterm-256color",
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd,
    env: input.env,
  }) as unknown as PtyProcess;

export class TerminalManager extends EventEmitter {
  #sessions = new Map<string, Session>();
  readonly #spawn: PtySpawner;

  constructor(spawn: PtySpawner = spawnRealPty) {
    super();
    this.#spawn = spawn;
  }

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
    if (existing && existing.status !== "exited") return snapshotOf(existing);

    // An unreachable cwd would make the spawn throw with a message that says
    // nothing useful; fall back so a terminal still opens.
    const cwd = existsSync(input.cwd) ? input.cwd : homedir();
    const session: Session = {
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd,
      worktreePath: input.worktreePath ?? null,
      env: { ...process.env, ...input.env, TERM: "xterm-256color" } as Record<string, string>,
      process: null,
      history: "",
      status: "starting",
      exitCode: null,
      exitSignal: null,
      updatedAt: new Date().toISOString(),
      pendingInput: "",
      spawnTimer: null,
      closing: false,
    };
    this.#sessions.set(key(input.threadId, input.terminalId), session);

    // A caller that already knows the geometry gets its shell immediately.
    if (input.cols !== undefined && input.rows !== undefined) {
      this.#start(session, input.cols, input.rows);
      return snapshotOf(session);
    }

    session.spawnTimer = setTimeout(() => {
      session.spawnTimer = null;
      if (session.process === null) this.#start(session, DEFAULT_COLS, DEFAULT_ROWS);
    }, SPAWN_SIZE_GRACE_MS);
    return snapshotOf(session);
  }

  /**
   * Start the shell, now that its size is settled.
   *
   * Split out of `open` because the size is the whole point: a shell inherits
   * `COLUMNS` from the PTY it is born into, and zsh's very first act is to
   * print `%` followed by `COLUMNS - 1` spaces so the line wraps, then erase it
   * with `CR space CR` (its PROMPT_SP partial-line marker). Spawning at the
   * placeholder 80 and resizing a moment later made that padding too long for
   * the real pane: the line wrapped early, the erase landed on the row below,
   * and a stray `%` was left on the first line of every terminal.
   */
  #start(session: Session, cols: number, rows: number): void {
    const child = this.#spawn({
      shell: defaultShell(),
      cwd: session.cwd,
      cols,
      rows,
      env: session.env,
    });
    session.process = child;
    session.status = "running";
    session.updatedAt = new Date().toISOString();

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
      // `close` already reported this terminal as closed and killing the PTY is
      // what brought us here — see Session.closing.
      if (session.closing) return;
      this.emit("output", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        type: "exited",
        exitCode,
        exitSignal: signal ?? null,
      });
    });

    // Before any output, so a listener holding a previous session's scrollback
    // clears it rather than appending this shell's prompt underneath.
    this.emit("output", {
      threadId: session.threadId,
      terminalId: session.terminalId,
      type: "started",
      snapshot: snapshotOf(session),
    });

    if (session.pendingInput !== "") {
      child.write(session.pendingInput);
      session.pendingInput = "";
    }
  }

  snapshot(threadId: string, terminalId: string): TerminalSnapshot | null {
    const session = this.#sessions.get(key(threadId, terminalId));
    return session ? snapshotOf(session) : null;
  }

  write(threadId: string, terminalId: string, data: string): void {
    const session = this.#sessions.get(key(threadId, terminalId));
    if (!session) return;
    // Typing into a terminal whose shell has not started yet is rare but real
    // (a script runs a command the moment it opens the panel); hold it rather
    // than dropping it on the floor.
    if (session.process === null) session.pendingInput += data;
    else session.process.write(data);
  }

  /**
   * The pane's real geometry — and, the first time, the shell's starting size.
   *
   * The renderer measures its surface after mounting, so this is where the true
   * size first becomes known. Starting the shell here rather than in `open` is
   * what keeps zsh's partial-line marker from being left on screen; see #start.
   */
  resize(threadId: string, terminalId: string, cols: number, rows: number): void {
    const session = this.#sessions.get(key(threadId, terminalId));
    if (!session || session.status === "exited") return;
    // node-pty throws on a zero dimension, which a hidden panel can report.
    if (cols < 1 || rows < 1) return;
    if (session.process === null) {
      if (session.spawnTimer !== null) {
        clearTimeout(session.spawnTimer);
        session.spawnTimer = null;
      }
      this.#start(session, cols, rows);
      return;
    }
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
      session.closing = true;
      if (session.spawnTimer !== null) {
        clearTimeout(session.spawnTimer);
        session.spawnTimer = null;
      }
      session.process?.kill();
      this.emit("output", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        type: "closed",
      });
    }
  }

  /**
   * Every live session, for the renderer's metadata subscription.
   *
   * The panel derives two things from this that it cannot derive locally: the
   * tab labels, and which ids are taken. Without it the id allocator only saw
   * the renderer's own list, so a terminal closed and reopened always got the
   * same `term-1` back and collided with the stream the previous one left
   * behind.
   */
  list(): TerminalSnapshot[] {
    return [...this.#sessions.values()].map(snapshotOf);
  }

  /** Kills everything; called when the window goes away. */
  closeAll(): void {
    for (const session of this.#sessions.values()) {
      session.closing = true;
      if (session.spawnTimer !== null) clearTimeout(session.spawnTimer);
      session.process?.kill();
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
    pid: session.status === "running" ? (session.process?.pid ?? null) : null,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: session.cwd.slice(session.cwd.lastIndexOf("/") + 1) || "terminal",
    updatedAt: session.updatedAt,
  };
}
