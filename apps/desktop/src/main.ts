/**
 * loop's desktop shell.
 *
 * Deliberately small. Upstream's Electron app is 131 files of Clerk auth,
 * tailscale, SSH, WSL and an auto-updater; none of that is loop's, so this is
 * written rather than forked. It does three things: open a window, keep one
 * `loop rpc` child alive, and pipe JSON-RPC between the two.
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  protocol,
  shell,
  utilityProcess,
} from "electron";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

import { CoreHost } from "./coreHost.js";
import { LoopProcess, resolveLoopBinary } from "./loopProcess.js";
import { HostClient, type HostProcess } from "./hostClient.js";
import { HOST_CALLBACKS, TERMINAL_PORT_CHANNEL } from "./hostProtocol.js";
import { PreviewManager, type PreviewColorScheme } from "./preview.js";

const RENDERER_SCHEME = "app";
const RENDERER_ORIGIN = `${RENDERER_SCHEME}://loop`;

/**
 * The renderer is served over a custom scheme rather than `file://`.
 *
 * The UI is a single-page app with real paths (`/project/:id`), and `file://`
 * has no notion of a history fallback — a reload on any route but `/` would
 * 404. A registered scheme also gives the page a real origin, which localStorage
 * and the router both need.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

/**
 * Paths are resolved from Electron's app root, not from this file.
 *
 * MEASURED: neither of the usual handles survives bundling here. Bun rewrites
 * `__dirname` in its CommonJS output to the **source** directory (`src/`), and
 * `import.meta.url` to the package root — so a path built from either was one
 * level off, and the preload plus every renderer asset 404'd with an error that
 * pointed at a plausible-looking wrong directory.
 *
 * `app.getAppPath()` is the directory holding this package's package.json in
 * development and the asar root once packaged, which is exactly what `dist/`
 * hangs off in both cases.
 */
const distDirectory = join(app.getAppPath(), "dist");
/** Laid down by build.ts. */
const rendererDirectory = resolve(distDirectory, "renderer");
const preloadPath = resolve(distDirectory, "preload", "index.cjs");
/** The workspace host's entry, forked as a utility process. Same trap as above. */
const hostPath = resolve(distDirectory, "host", "index.cjs");
/** The window icon, copied into dist alongside the renderer by `build.ts`. */
const appIconPath = resolve(distDirectory, "icon.png");

/**
 * The app ships every asset it uses, so nothing needs to be fetched from the
 * network. `wasm-unsafe-eval` is required by the terminal's ghostty wasm, and
 * inline styles by the bundled CSS-in-JS.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
].join("; ");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveRenderer(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  // normalize + a prefix check keeps a crafted `..` path inside the bundle.
  const candidate = normalize(join(rendererDirectory, decodeURIComponent(pathname)));
  const insideBundle = candidate.startsWith(rendererDirectory);
  const hasExtension = extname(pathname) !== "";

  // Anything without a file extension is a route, not an asset: hand back the
  // shell and let the router resolve it.
  const target = insideBundle && hasExtension ? candidate : join(rendererDirectory, "index.html");
  try {
    const body = await readFile(target);
    return new Response(body, {
      headers: {
        "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
        "content-security-policy": CONTENT_SECURITY_POLICY,
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/**
 * Where loop actually runs.
 *
 * Default: **in this process**, with core imported as the library it is. The
 * old path — spawn the compiled `loop rpc` binary and talk JSON-RPC over its
 * stdio — is still here and one env var away, because it is the fallback if
 * anything about running core under Electron's Node turns out to be wrong on
 * a machine this has not been tried on.
 *
 * `LOOP_SPAWN_BINARY=1` picks the child process. `LOOP_BINARY` still names
 * which binary that would be.
 *
 * Both satisfy the same tiny interface (`call` / `start` / `stop` / `running`
 * plus the three events), so nothing below this line knows which is in use —
 * and neither does the renderer.
 */
const anchorCwd = process.env["LOOP_ANCHOR_CWD"] ?? homedir();
const spawnBinary = process.env["LOOP_SPAWN_BINARY"] === "1";
const loopBinary = resolveLoopBinary(process.env["LOOP_BINARY"], app.getAppPath());
const loop = spawnBinary
  ? new LoopProcess({ binary: loopBinary, cwd: anchorCwd })
  : new CoreHost({ cwd: anchorCwd });

/**
 * git, terminals and the filesystem, in a process of their own.
 *
 * They used to run here. `uv_spawn` blocks the thread that calls it, and all
 * three spawn constantly — a workspace diff forks per repository, a shell pumps
 * a build log — so they stalled the thread running loop's core and the agent
 * turn on it. None of those modules imports `electron`, which is what let them
 * move without being rewritten.
 *
 * The commit-message callback is the one thing that still has to come back
 * here: loop owns the models and core runs in this process.
 */
const host = new HostClient(
  () =>
    utilityProcess.fork(hostPath, [], {
      // Named so it is identifiable in Activity Monitor rather than being a
      // second anonymous "Electron Helper" nobody can account for.
      serviceName: "loop workspace host",
      stdio: "pipe",
    }) as unknown as HostProcess,
  {
    [HOST_CALLBACKS.commitMessage]: (params) => loop.call("git.commitMessage", params),
  },
);
const previews = new PreviewManager();

let mainWindow: BrowserWindow | null = null;

/**
 * Give the host a pipe straight to the renderer, for terminal output.
 *
 * Every PTY byte used to arrive here purely to be handed on — main read it,
 * re-serialised it and forwarded it, adding nothing. A transferred
 * MessagePort removes that hop: the host writes and the renderer reads, with
 * this process not involved.
 *
 * Called whenever either end is replaced, because a port is only valid for the
 * pair that holds it. A renderer reload kills the far end; a host restart kills
 * the near one. Both re-run this, and the host closes the port it was holding
 * before taking the new one, so reloading in a loop cannot leak ports.
 */
function connectTerminalPort(): void {
  const target = mainWindow;
  if (!target || target.isDestroyed() || !host.running) return;
  const { port1, port2 } = new MessageChannelMain();
  host.transferPort(port1);
  target.webContents.postMessage(TERMINAL_PORT_CHANNEL, null, [port2]);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0b0b0c",
    // macOS takes its icon from the app bundle, so this is for Linux and
    // Windows, where an unset icon means the default Electron diamond.
    ...(process.platform === "darwin" ? {} : { icon: appIconPath }),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The browser panel renders each preview tab as a <webview>, which
      // Electron disables by default — without this the panel mounts and
      // stays blank, with no error to go on.
      webviewTag: true,
    },
  });

  // Links to the outside world open in the user's browser, never in the shell:
  // a navigated-away window has no way back and no address bar.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(RENDERER_ORIGIN)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Fires on the first load and on every reload, which is exactly when the
  // renderer's end of the terminal pipe needs replacing — the previous one
  // died with the document that held it.
  mainWindow.webContents.on("did-finish-load", connectTerminalPort);

  // The renderer insets its header to clear the traffic lights, and macOS
  // hides them in fullscreen — so without this the inset becomes a gap.
  mainWindow.on("enter-full-screen", () => forwardToRenderer("loop:fullscreen", true));
  mainWindow.on("leave-full-screen", () => forwardToRenderer("loop:fullscreen", false));

  void mainWindow.loadURL(`${RENDERER_ORIGIN}/`);
}

function forwardToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  protocol.handle(RENDERER_SCHEME, serveRenderer);

  /**
   * A preview guest is a browser, so its own links must not leak out of it.
   *
   * The window's two navigation handlers send every off-origin navigation to
   * the user's real browser — right for a link in the transcript, and exactly
   * wrong for the browser panel, where following a link is the whole point.
   * Guests get their own handler instead, and a `target=_blank` loads in the
   * panel rather than as a chromeless Electron window with no way back.
   */
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void contents.loadURL(url);
      return { action: "deny" };
    });
  });

  loop.on("notification", (message) => {
    if (message.method === "session.event") forwardToRenderer("loop:event", message.params);
  });
  loop.on("stderr", (line) => {
    // loop's own diagnostics belong in the shell's log, not swallowed.
    console.error(`[loop] ${line}`);
  });
  // Only a spawned binary can exit on its own; in-process core never emits
  // this, so the restart path is simply never armed.
  loop.on("exit", (code) => {
    console.error(`[loop] exited with ${code ?? "signal"}; restarting`);
    forwardToRenderer("loop:status", { running: false });
    // A crashed agent should not take the window with it.
    setTimeout(() => {
      loop.start();
      forwardToRenderer("loop:status", { running: loop.running });
    }, 1000);
  });
  // Which loop is running is the first thing to know when an RPC 404s, and it
  // is invisible otherwise — bundled and installed binaries look identical
  // from the renderer.
  console.error(`[loop] running: ${spawnBinary ? loopBinary : "in-process core"}`);
  loop.start();

  /**
   * Answers in an envelope rather than by throwing, and the preload unwraps it.
   *
   * An RPC error here is an ordinary outcome of the protocol, not a fault:
   * "Unknown sessionId" for a conversation that was deleted, "Method not
   * found" against an older loop, "a turn is already running". The renderer
   * handles all three. But a handler that REJECTS makes Electron print
   * `Error occurred in handler for 'loop:call'` with a full stack to the
   * main-process log every single time — so an app that was working correctly
   * read as one that was crashing.
   *
   * The envelope keeps the error (the renderer still throws, see preload.ts)
   * and drops the noise.
   */
  ipcMain.handle("loop:call", async (_event, payload: { method: string; params: unknown }) => {
    try {
      return { ok: true as const, value: await loop.call(payload.method, payload.params) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Everything the workspace host owns: the filesystem, git, GitHub, editors
   * and PTYs.
   *
   * Each of these was a handler that did the work here. They are forwards now,
   * and deliberately nothing more — the host returns exactly what these used to
   * return, envelopes included, so the renderer cannot tell the difference.
   * Keeping main a pipe is the point: the work that blocks a thread should not
   * be on the thread running loop's core.
   *
   * The channel name and the host method are the same string minus `loop:`, so
   * adding a capability means adding it to `hostHandlers.ts` and listing it
   * here.
   */
  const HOST_METHODS = [
    "fs.list",
    "fs.read",
    "fs.write",
    "fs.readAsset",
    "fs.browse",
    "git.discover",
    "git.refs",
    "git.status",
    "git.init",
    "git.diffPreview",
    "git.runStackedAction",
    "sc.lookup",
    "sc.clone",
    "sc.publish",
    "shell.which",
    "shell.launch",
    "pty.open",
    "pty.snapshot",
    "pty.list",
    "pty.write",
    "pty.resize",
    "pty.clear",
    "pty.close",
  ] as const;
  for (const method of HOST_METHODS) {
    ipcMain.handle(`loop:${method}`, (_event, params: unknown) => host.call(method, params));
  }

  // Terminal output and git-action progress arrive on the host's own schedule;
  // main forwards them by the channel the host names.
  host.on("notify", ({ channel, payload }) => forwardToRenderer(channel, payload));
  host.on("stderr", (line) => console.error(`[host] ${line}`));
  // The shells died with the host. Telling the renderer lets a pane show that
  // rather than sitting on a dead session waiting for bytes.
  host.on("lost", () => forwardToRenderer("loop:terminal.hostLost", {}));
  // A restarted host has no pipe — the old one went with the process that
  // held it — so it gets a fresh one as soon as it is up.
  host.on("ready", connectTerminalPort);
  host.start();

  /**
   * The browser panel.
   *
   * The renderer owns the `<webview>` element and this owns the guest behind
   * it — see preview.ts. Everything here is keyed by the renderer's tab id,
   * which is the only name the two halves share.
   */
  previews.on("state", (state) => forwardToRenderer("loop:preview.state", state));
  previews.on("frame", (frame) => forwardToRenderer("loop:preview.frame", frame));
  ipcMain.handle("loop:preview.config", () => previews.getPreviewConfig());
  ipcMain.handle("loop:preview.createTab", (_event, p: { tabId: string }) => {
    previews.createTab(p.tabId);
  });
  ipcMain.handle("loop:preview.closeTab", (_event, p: { tabId: string }) => {
    previews.closeTab(p.tabId);
  });
  ipcMain.handle(
    "loop:preview.registerWebview",
    (_event, p: { tabId: string; webContentsId: number }) => {
      previews.registerWebview(p.tabId, p.webContentsId);
    },
  );
  ipcMain.handle("loop:preview.states", () => previews.states());
  ipcMain.handle("loop:preview.navigate", (_event, p: { tabId: string; url: string }) =>
    previews.navigate(p.tabId, p.url),
  );
  ipcMain.handle("loop:preview.goBack", (_event, p: { tabId: string }) => {
    previews.goBack(p.tabId);
  });
  ipcMain.handle("loop:preview.goForward", (_event, p: { tabId: string }) => {
    previews.goForward(p.tabId);
  });
  ipcMain.handle("loop:preview.refresh", (_event, p: { tabId: string }) => {
    previews.refresh(p.tabId);
  });
  ipcMain.handle("loop:preview.hardReload", (_event, p: { tabId: string }) => {
    previews.hardReload(p.tabId);
  });
  ipcMain.handle("loop:preview.zoomIn", (_event, p: { tabId: string }) => {
    previews.zoomIn(p.tabId);
  });
  ipcMain.handle("loop:preview.zoomOut", (_event, p: { tabId: string }) => {
    previews.zoomOut(p.tabId);
  });
  ipcMain.handle("loop:preview.resetZoom", (_event, p: { tabId: string }) => {
    previews.resetZoom(p.tabId);
  });
  ipcMain.handle(
    "loop:preview.setColorScheme",
    (_event, p: { tabId: string; colorScheme: PreviewColorScheme }) =>
      previews.setColorScheme(p.tabId, p.colorScheme),
  );
  ipcMain.handle("loop:preview.openDevTools", (_event, p: { tabId: string }) => {
    previews.openDevTools(p.tabId);
  });
  ipcMain.handle("loop:preview.clearCookies", () => previews.clearCookies());
  ipcMain.handle("loop:preview.clearCache", () => previews.clearCache());
  ipcMain.handle("loop:preview.screenshot", (_event, p: { tabId: string }) =>
    previews.captureScreenshot(p.tabId),
  );
  ipcMain.handle("loop:preview.revealArtifact", (_event, p: { path: string }) => {
    previews.revealArtifact(p.path);
  });
  ipcMain.handle("loop:preview.copyArtifact", (_event, p: { path: string }) =>
    previews.copyArtifactToClipboard(p.path),
  );
  ipcMain.handle("loop:preview.startScreencast", (_event, p: { tabId: string }) =>
    previews.startScreencast(p.tabId),
  );
  ipcMain.handle("loop:preview.stopScreencast", (_event, p: { tabId: string }) =>
    previews.stopScreencast(p.tabId),
  );
  ipcMain.handle(
    "loop:preview.saveRecording",
    (_event, p: { tabId: string; mimeType: string; data: Uint8Array }) =>
      previews.saveRecording(p.tabId, p.mimeType, p.data),
  );

  // Asked once on mount, because a reload mid-fullscreen would otherwise wait
  // for a transition that already happened.
  ipcMain.handle("loop:window.isFullscreen", () => mainWindow?.isFullScreen() ?? false);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Killing the host takes its shells with it — they are its children — but
  // asking first gives each one a chance to die cleanly rather than being
  // orphaned mid-write.
  void host.call("pty.closeAll").catch(() => {});
  host.stop();
  previews.disposeAll();
  loop.stop();
});
