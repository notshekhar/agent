/**
 * The `window.loop` bridge.
 *
 * This is the exact shape `apps/web/src/loop/transport.ts` looks for, and the
 * only thing the renderer is given: one call, one event subscription, one
 * anchor folder. Node stays on this side of `contextIsolation` — the renderer
 * gets three functions, not a process handle.
 */
import { contextBridge, ipcRenderer } from "electron";

interface LoopEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly part: unknown;
}

/**
 * Turn the main process's `{ok, value|error}` envelope back into a promise
 * that resolves or throws.
 *
 * `loop:call` answers in an envelope so that an ordinary RPC failure — an
 * unknown session, a method an older loop does not have — does not reject
 * inside `ipcMain.handle`, which makes Electron log a stack trace for
 * something the renderer handles perfectly well. The error still reaches the
 * caller; it just no longer looks like a crash. See main.ts.
 *
 * An answer that is not an envelope is passed through, so a build where only
 * one side has been updated still works.
 */
function unwrap(answer: unknown): unknown {
  if (typeof answer !== "object" || answer === null || !("ok" in answer)) return answer;
  const envelope = answer as { ok: boolean; value?: unknown; error?: string };
  if (envelope.ok) return envelope.value;
  throw new Error(envelope.error ?? "loop call failed");
}

const listeners = new Set<(event: LoopEvent) => void>();

ipcRenderer.on("loop:event", (_event, payload: LoopEvent) => {
  for (const listener of listeners) listener(payload);
});

const terminalListeners = new Set<(event: unknown) => void>();
ipcRenderer.on("loop:terminal", (_event, payload: unknown) => {
  for (const listener of terminalListeners) listener(payload);
});

const gitActionListeners = new Set<(event: unknown) => void>();
ipcRenderer.on("loop:gitAction", (_event, payload: unknown) => {
  for (const listener of gitActionListeners) listener(payload);
});

const fullscreenListeners = new Set<(fullscreen: boolean) => void>();
ipcRenderer.on("loop:fullscreen", (_event, fullscreen: boolean) => {
  for (const listener of fullscreenListeners) listener(fullscreen);
});

contextBridge.exposeInMainWorld("loop", {
  call(method: string, params: unknown, cwd: string | undefined): Promise<unknown> {
    // `cwd` rides as a parameter rather than picking a process: one loop child
    // serves every project, because sessions carry their own cwd.
    const withCwd =
      cwd === undefined ? params : { cwd, ...(params as Record<string, unknown> | undefined) };
    return ipcRenderer.invoke("loop:call", { method, params: withCwd }).then(unwrap);
  },
  onEvent(listener: (event: LoopEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  fs: {
    list(cwd: string) {
      return ipcRenderer.invoke("loop:fs.list", { cwd });
    },
    read(cwd: string, relativePath: string) {
      return ipcRenderer.invoke("loop:fs.read", { cwd, relativePath });
    },
    browse(partialPath: string, cwd: string | undefined) {
      return ipcRenderer.invoke("loop:fs.browse", { partialPath, cwd });
    },
  },
  sourceControl: {
    lookup: (repository: string) => ipcRenderer.invoke("loop:sc.lookup", { repository }),
    clone: (input: unknown) => ipcRenderer.invoke("loop:sc.clone", input),
    publish: (input: unknown) => ipcRenderer.invoke("loop:sc.publish", input),
  },
  shell: {
    which: (commands: string[]) => ipcRenderer.invoke("loop:shell.which", { commands }),
    launch: (command: string | null, args: string[], target: string) =>
      ipcRenderer.invoke("loop:shell.launch", { command, args, target }),
  },
  git: {
    refs: (cwd: string) => ipcRenderer.invoke("loop:git.refs", { cwd }),
    status: (cwd: string) => ipcRenderer.invoke("loop:git.status", { cwd }),
    init: (cwd: string) => ipcRenderer.invoke("loop:git.init", { cwd }),
    diffPreview: (cwd: string, options: { baseRef?: string; ignoreWhitespace?: boolean }) =>
      ipcRenderer.invoke("loop:git.diffPreview", { cwd, ...options }),
    runStackedAction: (input: unknown) => ipcRenderer.invoke("loop:git.runStackedAction", input),
    discover: () => ipcRenderer.invoke("loop:git.discover"),
    onActionProgress(listener: (event: unknown) => void): () => void {
      gitActionListeners.add(listener);
      return () => gitActionListeners.delete(listener);
    },
  },
  pty: {
    open: (input: unknown) => ipcRenderer.invoke("loop:pty.open", input),
    snapshot: (threadId: string, terminalId: string) =>
      ipcRenderer.invoke("loop:pty.snapshot", { threadId, terminalId }),
    list: () => ipcRenderer.invoke("loop:pty.list"),
    write: (threadId: string, terminalId: string, data: string) =>
      ipcRenderer.invoke("loop:pty.write", { threadId, terminalId, data }),
    resize: (threadId: string, terminalId: string, cols: number, rows: number) =>
      ipcRenderer.invoke("loop:pty.resize", { threadId, terminalId, cols, rows }),
    clear: (threadId: string, terminalId: string) =>
      ipcRenderer.invoke("loop:pty.clear", { threadId, terminalId }),
    close: (threadId: string, terminalId: string | undefined) =>
      ipcRenderer.invoke("loop:pty.close", { threadId, terminalId }),
    onOutput(listener: (event: unknown) => void): () => void {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
  },
  window: {
    /** macOS hides the traffic lights in fullscreen, so the header's inset
        for them has to come back off. */
    isFullscreen(): Promise<boolean> {
      return ipcRenderer.invoke("loop:window.isFullscreen");
    },
    onFullscreenChange(listener: (fullscreen: boolean) => void): () => void {
      fullscreenListeners.add(listener);
      return () => fullscreenListeners.delete(listener);
    },
  },
  anchorCwd(): Promise<string | undefined> {
    return ipcRenderer
      .invoke("loop:call", { method: "server.info", params: {} })
      .then(unwrap)
      .then((info) => (info as { defaults?: { cwd?: string } } | undefined)?.defaults?.cwd)
      .catch(() => undefined);
  },
});
