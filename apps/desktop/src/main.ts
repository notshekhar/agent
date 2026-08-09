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

import { CoreHost } from "./coreHost.js";
import { LoopProcess, resolveLoopBinary } from "./loopProcess.js";
import {
  diffPreview as gitDiffPreview,
  init as gitInit,
  listRefs,
  status as gitStatus,
} from "./git.js";
import { discoverSourceControl } from "./discovery.js";
import { launch, revealCommand, whichCommands } from "./launcher.js";
import {
  cloneRepository,
  lookupRepository,
  publishRepository,
} from "./sourceControl.js";
import {
  runStackedAction as gitRunStackedAction,
  type GitStackedAction,
  type GitStackedActionResult,
} from "./gitActions.js";
import { PreviewManager, type PreviewColorScheme } from "./preview.js";
import { TerminalManager } from "./terminals.js";
import {
  browseFilesystem,
  listWorkspaceEntries,
  readWorkspaceAsset,
  readWorkspaceFile,
} from "./workspaceFiles.js";

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

const terminals = new TerminalManager();
const previews = new PreviewManager();

let mainWindow: BrowserWindow | null = null;

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

  // Filesystem reads live here rather than in loop: loop speaks an agent
  // protocol and has no file operations, and the renderer has no filesystem.
  ipcMain.handle("loop:fs.list", (_event, payload: { cwd: string }) =>
    listWorkspaceEntries(payload.cwd),
  );
  ipcMain.handle("loop:fs.read", (_event, payload: { cwd: string; relativePath: string }) =>
    readWorkspaceFile(payload.cwd, payload.relativePath),
  );
  // Bytes, for the panes that are not text — the image preview above all.
  ipcMain.handle("loop:fs.readAsset", (_event, payload: { absolutePath: string }) =>
    readWorkspaceAsset(payload.absolutePath),
  );
  ipcMain.handle("loop:git.discover", () => discoverSourceControl());

  /**
   * Repository-level GitHub work. Each returns `ok:false` with gh's own message
   * rather than rejecting, so the toast shows "name already exists" instead of
   * Electron's remote-method wrapper.
   */
  const ipcResult = async <T>(work: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await work() };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  };
  ipcMain.handle("loop:sc.lookup", (_event, p: { repository: string }) =>
    ipcResult(() => lookupRepository(p.repository)),
  );
  ipcMain.handle(
    "loop:sc.clone",
    (
      _event,
      p: {
        repository?: string;
        remoteUrl?: string;
        destinationPath: string;
        protocol?: "auto" | "ssh" | "https";
      },
    ) => ipcResult(() => cloneRepository(p)),
  );
  ipcMain.handle(
    "loop:sc.publish",
    (
      _event,
      p: {
        cwd: string;
        repository: string;
        visibility: "private" | "public";
        remoteName?: string;
      },
    ) => ipcResult(() => publishRepository(p)),
  );
  ipcMain.handle("loop:shell.which", (_event, p: { commands: string[] }) =>
    whichCommands(p.commands),
  );
  ipcMain.handle(
    "loop:shell.launch",
    async (_event, p: { command: string | null; args: string[]; target: string }) => {
      // A null command means the OS file manager — the one "editor" that is not
      // a binary the user installed.
      const reveal = revealCommand();
      const command = p.command ?? reveal.command;
      const args = p.command ? p.args : [...reveal.args, p.target];
      try {
        await launch(command, args);
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
  ipcMain.handle("loop:git.refs", (_event, p: { cwd: string }) => listRefs(p.cwd));
  ipcMain.handle("loop:git.status", (_event, p: { cwd: string }) => gitStatus(p.cwd));
  ipcMain.handle("loop:git.init", (_event, p: { cwd: string }) => gitInit(p.cwd));
  ipcMain.handle(
    "loop:git.diffPreview",
    (_event, p: { cwd: string; baseRef?: string; ignoreWhitespace?: boolean }) =>
      gitDiffPreview(p.cwd, {
        ...(p.baseRef === undefined ? {} : { baseRef: p.baseRef }),
        ...(p.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: p.ignoreWhitespace }),
      }),
  );

  /**
   * Commit / push / open a PR.
   *
   * Progress goes out on its own channel rather than as the reply, because the
   * point of it is to arrive *during* the action — a pre-commit hook running a
   * test suite has two minutes of output the toast should be showing. The reply
   * carries the outcome, and a failure comes back as `ok: false` rather than a
   * rejected invoke so the renderer gets git's own message instead of
   * Electron's "Error invoking remote method" wrapper.
   */
  ipcMain.handle(
    "loop:git.runStackedAction",
    async (
      _event,
      p: {
        actionId: string;
        cwd: string;
        action: GitStackedAction;
        commitMessage?: string;
        featureBranch?: boolean;
        filePaths?: string[];
      },
    ): Promise<
      { ok: true; value: GitStackedActionResult } | { ok: false; error: string }
    > => {
      const stamp = { actionId: p.actionId, cwd: p.cwd, action: p.action };
      try {
        const value = await gitRunStackedAction(
          p.cwd,
          {
            action: p.action,
            commitMessage: p.commitMessage,
            featureBranch: p.featureBranch,
            filePaths: p.filePaths,
          },
          {
            emit: (progress) => forwardToRenderer("loop:gitAction", { ...stamp, ...progress }),
            // loop owns the models; this module owns git. A message it cannot
            // get back is handled by the runner's own fallback subject.
            generateMessage: async ({ diff, branch }) => {
              const reply = (await loop.call("git.commitMessage", {
                diff,
                cwd: p.cwd,
                ...(branch ? { branch } : {}),
              })) as { message?: unknown } | null;
              return typeof reply?.message === "string" ? reply.message : "";
            },
          },
        );
        return { ok: true as const, value };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  terminals.on("output", (event) => forwardToRenderer("loop:terminal", event));
  ipcMain.handle("loop:pty.open", (_event, input) => terminals.open(input));
  ipcMain.handle("loop:pty.snapshot", (_event, p: { threadId: string; terminalId: string }) =>
    terminals.snapshot(p.threadId, p.terminalId),
  );
  ipcMain.handle("loop:pty.list", () => terminals.list());
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
  terminals.closeAll();
  previews.disposeAll();
  loop.stop();
});
