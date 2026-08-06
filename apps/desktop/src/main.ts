/**
 * loop's desktop shell.
 *
 * Deliberately small. Upstream's Electron app is 131 files of Clerk auth,
 * tailscale, SSH, WSL and an auto-updater; none of that is loop's, so this is
 * written rather than forked. It does three things: open a window, keep one
 * `loop rpc` child alive, and pipe JSON-RPC between the two.
 */
import { app, BrowserWindow, ipcMain, protocol, shell } from "electron";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

import { LoopProcess, resolveLoopBinary } from "./loopProcess.js";
import { TerminalManager } from "./terminals.js";
import { browseFilesystem, listWorkspaceEntries, readWorkspaceFile } from "./workspaceFiles.js";

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

const loop = new LoopProcess({
  binary: resolveLoopBinary(process.env["LOOP_BINARY"]),
  // Only a default for calls that omit cwd; sessions carry their own.
  cwd: process.env["LOOP_ANCHOR_CWD"] ?? homedir(),
});

const terminals = new TerminalManager();

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0b0b0c",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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

  void mainWindow.loadURL(`${RENDERER_ORIGIN}/`);
}

function forwardToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  protocol.handle(RENDERER_SCHEME, serveRenderer);

  loop.on("notification", (message) => {
    if (message.method === "session.event") forwardToRenderer("loop:event", message.params);
  });
  loop.on("stderr", (line) => {
    // loop's own diagnostics belong in the shell's log, not swallowed.
    console.error(`[loop] ${line}`);
  });
  loop.on("exit", (code) => {
    console.error(`[loop] exited with ${code ?? "signal"}; restarting`);
    forwardToRenderer("loop:status", { running: false });
    // A crashed agent should not take the window with it.
    setTimeout(() => {
      loop.start();
      forwardToRenderer("loop:status", { running: loop.running });
    }, 1000);
  });
  loop.start();

  ipcMain.handle("loop:call", async (_event, payload: { method: string; params: unknown }) => {
    return await loop.call(payload.method, payload.params);
  });

  // Filesystem reads live here rather than in loop: loop speaks an agent
  // protocol and has no file operations, and the renderer has no filesystem.
  ipcMain.handle("loop:fs.list", (_event, payload: { cwd: string }) =>
    listWorkspaceEntries(payload.cwd),
  );
  ipcMain.handle("loop:fs.read", (_event, payload: { cwd: string; relativePath: string }) =>
    readWorkspaceFile(payload.cwd, payload.relativePath),
  );
  terminals.on("output", (event) => forwardToRenderer("loop:terminal", event));
  ipcMain.handle("loop:pty.open", (_event, input) => terminals.open(input));
  ipcMain.handle("loop:pty.snapshot", (_event, p: { threadId: string; terminalId: string }) =>
    terminals.snapshot(p.threadId, p.terminalId),
  );
  ipcMain.handle("loop:pty.write", (_event, p: { threadId: string; terminalId: string; data: string }) => {
    terminals.write(p.threadId, p.terminalId, p.data);
  });
  ipcMain.handle(
    "loop:pty.resize",
    (_event, p: { threadId: string; terminalId: string; cols: number; rows: number }) => {
      terminals.resize(p.threadId, p.terminalId, p.cols, p.rows);
    },
  );
  ipcMain.handle("loop:pty.clear", (_event, p: { threadId: string; terminalId: string }) => {
    terminals.clear(p.threadId, p.terminalId);
  });
  ipcMain.handle("loop:pty.close", (_event, p: { threadId: string; terminalId?: string }) => {
    terminals.close(p.threadId, p.terminalId);
  });

  ipcMain.handle(
    "loop:fs.browse",
    (_event, payload: { partialPath: string; cwd: string | undefined }) =>
      browseFilesystem(payload.partialPath, payload.cwd),
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  terminals.closeAll();
  loop.stop();
});
