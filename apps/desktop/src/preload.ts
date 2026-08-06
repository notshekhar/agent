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

const listeners = new Set<(event: LoopEvent) => void>();

ipcRenderer.on("loop:event", (_event, payload: LoopEvent) => {
  for (const listener of listeners) listener(payload);
});

contextBridge.exposeInMainWorld("loop", {
  call(method: string, params: unknown, cwd: string | undefined): Promise<unknown> {
    // `cwd` rides as a parameter rather than picking a process: one loop child
    // serves every project, because sessions carry their own cwd.
    const withCwd =
      cwd === undefined ? params : { cwd, ...(params as Record<string, unknown> | undefined) };
    return ipcRenderer.invoke("loop:call", { method, params: withCwd });
  },
  onEvent(listener: (event: LoopEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  anchorCwd(): Promise<string | undefined> {
    return ipcRenderer
      .invoke("loop:call", { method: "server.info", params: {} })
      .then((info: { defaults?: { cwd?: string } }) => info?.defaults?.cwd)
      .catch(() => undefined);
  },
});
