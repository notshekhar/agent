/**
 * The browser panel's main-process half.
 *
 * The renderer paints a `<webview>` per preview tab, but a guest webview is
 * driven from the main process, not from the page that hosts it: the embedder
 * gets a DOM element and a `getWebContentsId()`, and everything else — load a
 * URL, go back, zoom, tell me when the page finished loading — lives on the
 * `WebContents` behind that id.
 *
 * That half was missing. The renderer asks for it as `preview.getPreviewConfig()`
 * before it will mount a webview at all (apps/web/src/browser/HostedBrowserWebview.tsx
 * returns null while the config is unresolved), so with nothing answering, the
 * panel enabled its Browser tab, accepted a URL, recorded the tab server-side —
 * and never created a single webview. Typing chess.com did nothing, silently.
 *
 * The renderer's contract is upstream's `DesktopPreviewBridge`. It is restated
 * here in plain types rather than imported, because this package does not
 * depend on `@loop/contracts` and never has; the shapes below are the ones that
 * cross the IPC boundary, and they must stay in step with
 * `apps/web/src/loop/contracts/ipc.ts`.
 */
import {
  app,
  clipboard,
  nativeImage,
  session,
  shell,
  webContents as electronWebContents,
  type WebContents,
} from "electron";
import { EventEmitter } from "node:events";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildAnnotationPayload,
  CANCEL_PICKER_SCRIPT,
  PICKER_SCRIPT,
  screenshotCropRect,
  type PickedGuestElement,
  type PreviewAnnotationPayload,
} from "./previewPicker";

/**
 * One session for every preview tab, separate from the app's own.
 *
 * `persist:` so a login survives a restart — a preview pointed at a staging
 * site should not ask for a password every launch — and separate so clearing
 * preview cookies cannot sign the user out of anything the app itself holds.
 */
export const PREVIEW_PARTITION = "persist:loop-preview";

/**
 * The guest's own security posture, as a `<webview webpreferences>` string.
 *
 * loop ships no picker preload, so unlike upstream there is no reason to
 * weaken context isolation: the guest is an ordinary sandboxed web page with
 * no bridge into either the app or Node. Element picking is injected on demand
 * instead (apps/desktop/src/previewPicker.ts), which needs none of that.
 *
 * `plugins` is what enables Chromium's built-in PDF viewer, and nothing else —
 * the plugin architectures it used to gate are long gone. Without it a `.pdf`
 * the panel is asked to open (openFileInPreview treats pdf as previewable)
 * downloads instead of rendering.
 */
const WEBVIEW_PREFERENCES = "contextIsolation=yes,sandbox=yes,nodeIntegration=no,plugins=yes";

/** Chrome's zoom ladder, which is what the +/- buttons are expected to walk. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export type PreviewColorScheme = "system" | "light" | "dark";

export type PreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | { kind: "LoadFailed"; url: string; title: string; code: number; description: string };

export interface PreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: PreviewColorScheme;
  controller: "human" | "agent" | "none";
  updatedAt: string;
}

export interface PreviewWebviewConfig {
  partition: string;
  webPreferences: string;
  preloadUrl: string | null;
}

export interface PreviewArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface PreviewScreencastFrame {
  tabId: string;
  data: string;
  width: number;
  height: number;
  receivedAt: string;
}

interface Tab {
  readonly tabId: string;
  contents: WebContents | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  colorScheme: PreviewColorScheme;
  screencasting: boolean;
  /** Removes every listener this manager put on `contents`. */
  detach: (() => void) | null;
}

/**
 * A load the user cancelled, or that a redirect superseded, is not a failure.
 *
 * `ERR_ABORTED` arrives on every ordinary in-page navigation away from a page
 * that is still loading; surfacing it would flash the "can't reach this page"
 * screen over a page that is about to render fine.
 */
const ERR_ABORTED = -3;

function nowIso(): string {
  return new Date().toISOString();
}

function alive(contents: WebContents | null): contents is WebContents {
  return contents !== null && !contents.isDestroyed();
}

export class PreviewManager extends EventEmitter {
  readonly #tabs = new Map<string, Tab>();
  /** Screenshots and recordings, written once the first one is asked for. */
  #artifactDirectory: string | null = null;

  /**
   * Everything the renderer needs to mount a webview, in one call.
   *
   * `preloadUrl: null` is a real answer, not a stub: it is how the renderer is
   * told there is no element picker in this build.
   */
  getPreviewConfig(): PreviewWebviewConfig {
    return {
      partition: PREVIEW_PARTITION,
      webPreferences: WEBVIEW_PREFERENCES,
      preloadUrl: null,
    };
  }

  createTab(tabId: string): void {
    if (this.#tabs.has(tabId)) return;
    this.#tabs.set(tabId, {
      tabId,
      contents: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
      colorScheme: "system",
      screencasting: false,
      detach: null,
    });
    this.#emit(tabId);
  }

  closeTab(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    if (!tab) return;
    this.#stopScreencast(tab);
    tab.detach?.();
    this.#tabs.delete(tabId);
  }

  /**
   * Bind a tab to the guest the renderer just attached.
   *
   * Called again on every `did-attach` and `dom-ready`, and after a crash the
   * renderer swaps the element for a fresh one — so this has to be idempotent
   * and has to replace an earlier binding rather than stack listeners on it.
   */
  registerWebview(tabId: string, webContentsId: number): void {
    const tab = this.#tabs.get(tabId) ?? this.#create(tabId);
    const contents = electronWebContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed()) return;
    if (tab.contents === contents) return;

    tab.detach?.();
    tab.contents = contents;

    const sync = () => {
      if (!alive(contents)) return;
      tab.canGoBack = contents.navigationHistory.canGoBack();
      tab.canGoForward = contents.navigationHistory.canGoForward();
      this.#emit(tabId);
    };
    const loading = () => {
      if (!alive(contents)) return;
      const url = contents.getURL();
      // about:blank is the mount placeholder, not a page the user asked for.
      if (url === "" || url === "about:blank") return;
      tab.navStatus = { kind: "Loading", url, title: contents.getTitle() || url };
      sync();
    };
    const settled = () => {
      if (!alive(contents)) return;
      const url = contents.getURL();
      if (url === "" || url === "about:blank") {
        tab.navStatus = { kind: "Idle" };
        sync();
        return;
      }
      // A failed load already wrote its own terminal status, and
      // `did-stop-loading` fires after it too — overwriting it here would
      // replace "can't reach this site" with a success for a blank page. The
      // next attempt clears it: `did-start-loading` always runs first.
      if (tab.navStatus.kind !== "LoadFailed") {
        tab.navStatus = { kind: "Success", url, title: contents.getTitle() || url };
      }
      sync();
    };
    const retitled = (_event: unknown, title: string) => {
      if (tab.navStatus.kind === "Idle") return;
      tab.navStatus = { ...tab.navStatus, title };
      this.#emit(tabId);
    };
    const failed = (
      _event: unknown,
      code: number,
      description: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      tab.navStatus = {
        kind: "LoadFailed",
        url: validatedUrl,
        title: validatedUrl,
        code,
        description,
      };
      sync();
    };
    const gone = () => {
      if (tab.contents !== contents) return;
      tab.contents = null;
      tab.screencasting = false;
      this.#emit(tabId);
    };

    contents.on("did-start-loading", loading);
    contents.on("did-stop-loading", settled);
    contents.on("did-navigate", sync);
    contents.on("did-navigate-in-page", settled);
    contents.on("page-title-updated", retitled);
    contents.on("did-fail-load", failed);
    contents.on("destroyed", gone);

    tab.detach = () => {
      contents.off("did-start-loading", loading);
      contents.off("did-stop-loading", settled);
      contents.off("did-navigate", sync);
      contents.off("did-navigate-in-page", settled);
      contents.off("page-title-updated", retitled);
      contents.off("did-fail-load", failed);
      contents.off("destroyed", gone);
    };

    // A swapped-in guest starts at the defaults; re-apply what the tab was set
    // to so a crash recovery does not silently reset the user's zoom.
    contents.setZoomFactor(tab.zoomFactor);
    if (tab.colorScheme !== "system") void this.#applyColorScheme(tab);
    sync();
  }

  /**
   * Point a tab at a URL.
   *
   * `loadURL` rejects on the same aborts that `did-fail-load` filters out, so
   * the rejection is swallowed here and the page's real outcome comes back
   * through the listeners above. Rejecting would make the address bar report a
   * failure for a load that is about to succeed.
   */
  async navigate(tabId: string, url: string): Promise<void> {
    const contents = this.#require(tabId);
    try {
      await contents.loadURL(url);
    } catch {
      // Reported by did-fail-load when it is a real failure.
    }
  }

  goBack(tabId: string): void {
    const contents = this.#require(tabId);
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  }

  goForward(tabId: string): void {
    const contents = this.#require(tabId);
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  }

  refresh(tabId: string): void {
    this.#require(tabId).reload();
  }

  hardReload(tabId: string): void {
    this.#require(tabId).reloadIgnoringCache();
  }

  zoomIn(tabId: string): void {
    this.#setZoom(tabId, (current) => ZOOM_STEPS.find((step) => step > current + 0.001) ?? current);
  }

  zoomOut(tabId: string): void {
    this.#setZoom(
      tabId,
      (current) => [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? current,
    );
  }

  resetZoom(tabId: string): void {
    this.#setZoom(tabId, () => 1);
  }

  async setColorScheme(tabId: string, colorScheme: PreviewColorScheme): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (!tab) return;
    tab.colorScheme = colorScheme;
    await this.#applyColorScheme(tab);
    this.#emit(tabId);
  }

  /**
   * DevTools and CDP are mutually exclusive on one WebContents.
   *
   * A colour-scheme override holds the debugger open, and Electron answers
   * `openDevTools` with "another debugger is already attached" while it does —
   * so the override is dropped for as long as DevTools is the thing the user
   * asked for, and reinstated when they close it.
   */
  openDevTools(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    const contents = this.#require(tabId);
    if (tab && !tab.screencasting && contents.debugger.isAttached()) {
      contents.debugger.detach();
    }
    contents.openDevTools({ mode: "detach" });
    if (tab && tab.colorScheme !== "system") {
      contents.once("devtools-closed", () => {
        void this.#applyColorScheme(tab);
      });
    }
  }

  /**
   * Arms the in-page element picker and resolves with the annotation the user
   * picked, or null if they pressed Escape, navigated away, or armed it again.
   *
   * The script's promise is the whole protocol — `executeJavaScript` resolves
   * with whatever it resolves with — so a navigation mid-pick would otherwise
   * leave this hanging forever with the button stuck lit.
   */
  async pickElement(tabId: string): Promise<PreviewAnnotationPayload | null> {
    const contents = this.#require(tabId);
    const tab = this.#tabs.get(tabId);
    const abandoned = new Promise<null>((resolve) => {
      const done = () => {
        contents.off("did-start-navigation", done);
        contents.off("destroyed", done);
        resolve(null);
      };
      contents.once("did-start-navigation", done);
      contents.once("destroyed", done);
    });

    // Escape is handled by a listener inside the guest, so the guest has to own
    // the keyboard for it to arrive. `PreviewView` puts focus back where the
    // user left it once the pick settles.
    contents.focus();

    let picked: PickedGuestElement | null = null;
    try {
      picked = (await Promise.race([
        contents.executeJavaScript(PICKER_SCRIPT, true) as Promise<PickedGuestElement | null>,
        abandoned,
      ])) as PickedGuestElement | null;
    } catch {
      // Frame torn down under the pick; treat as a cancel.
      picked = null;
    }
    if (!picked || !alive(contents)) return null;

    const screenshot = await this.#captureAnnotationCrop(contents, picked, tab?.zoomFactor ?? 1);
    return buildAnnotationPayload({ picked, screenshot, now: new Date() });
  }

  cancelPickElement(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    if (!alive(tab?.contents ?? null)) return;
    void tab!.contents!.executeJavaScript(CANCEL_PICKER_SCRIPT, true).catch(() => undefined);
  }

  async #captureAnnotationCrop(
    contents: WebContents,
    picked: PickedGuestElement,
    zoomFactor: number,
  ): Promise<PreviewAnnotationPayload["screenshot"]> {
    try {
      const crop = screenshotCropRect(picked.rect, zoomFactor, picked.viewport);
      // A rect that clamps to nothing (element scrolled out of view) still
      // deserves a screenshot — the whole viewport says more than none at all.
      const image = crop ? await contents.capturePage(crop) : await contents.capturePage();
      const imageSize = image.getSize();
      return {
        dataUrl: image.toDataURL(),
        width: imageSize.width,
        height: imageSize.height,
        cropRect: crop ?? { x: 0, y: 0, width: imageSize.width, height: imageSize.height },
      };
    } catch {
      return null;
    }
  }

  async clearCookies(): Promise<void> {
    await session.fromPartition(PREVIEW_PARTITION).clearStorageData();
  }

  async clearCache(): Promise<void> {
    await session.fromPartition(PREVIEW_PARTITION).clearCache();
  }

  async captureScreenshot(tabId: string): Promise<PreviewArtifact> {
    const contents = this.#require(tabId);
    const image = await contents.capturePage();
    const createdAt = nowIso();
    const path = join(
      await this.#artifacts(),
      `screenshot-${createdAt.replace(/[:.]/g, "-")}.png`,
    );
    const png = image.toPNG();
    await writeFile(path, png);
    return {
      id: `screenshot-${createdAt}`,
      tabId,
      path,
      mimeType: "image/png",
      sizeBytes: png.byteLength,
      createdAt,
    };
  }

  revealArtifact(path: string): void {
    shell.showItemInFolder(path);
  }

  async copyArtifactToClipboard(path: string): Promise<void> {
    if (path.toLowerCase().endsWith(".png")) {
      const image = nativeImage.createFromPath(path);
      if (!image.isEmpty()) {
        clipboard.writeImage(image);
        return;
      }
    }
    // A video has no clipboard representation the OS will paste anywhere
    // useful; the path is the thing the user can actually do something with.
    clipboard.writeText(path);
  }

  /**
   * Stream the guest's frames to the renderer, which assembles them into a
   * video. CDP is the only way to get them — `capturePage` in a loop drops to
   * single-digit fps and stalls the page it is capturing.
   */
  async startScreencast(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    const contents = this.#require(tabId);
    if (!tab || tab.screencasting) return;
    this.#attachDebugger(contents);
    tab.screencasting = true;
    contents.debugger.on("message", this.#onDebuggerMessage(tab));
    await contents.debugger.sendCommand("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      everyNthFrame: 1,
    });
  }

  async stopScreencast(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (!tab) return;
    this.#stopScreencast(tab);
  }

  async saveRecording(tabId: string, mimeType: string, data: Uint8Array): Promise<PreviewArtifact> {
    const createdAt = nowIso();
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const path = join(
      await this.#artifacts(),
      `recording-${createdAt.replace(/[:.]/g, "-")}.${extension}`,
    );
    await writeFile(path, data);
    const { size } = await stat(path);
    return { id: `recording-${createdAt}`, tabId, path, mimeType, sizeBytes: size, createdAt };
  }

  /** Every tab's state, for a renderer that reloaded and lost its copy. */
  states(): PreviewTabState[] {
    return [...this.#tabs.keys()].map((tabId) => this.#state(tabId)).filter((s) => s !== null);
  }

  disposeAll(): void {
    for (const tabId of [...this.#tabs.keys()]) this.closeTab(tabId);
  }

  #create(tabId: string): Tab {
    this.createTab(tabId);
    return this.#tabs.get(tabId)!;
  }

  /**
   * The tab's live WebContents, or a message the renderer can show.
   *
   * Throwing beats a silent no-op: every caller either awaits this behind a
   * toast or ignores the result, and "the page isn't loaded yet" is far easier
   * to act on than a button that does nothing.
   */
  #require(tabId: string): WebContents {
    const tab = this.#tabs.get(tabId);
    if (!alive(tab?.contents ?? null)) {
      throw new Error(`Preview tab ${tabId} has no live page.`);
    }
    return tab!.contents!;
  }

  #setZoom(tabId: string, next: (current: number) => number): void {
    const tab = this.#tabs.get(tabId);
    const contents = this.#require(tabId);
    if (!tab) return;
    tab.zoomFactor = next(tab.zoomFactor);
    contents.setZoomFactor(tab.zoomFactor);
    this.#emit(tabId);
  }

  #attachDebugger(contents: WebContents): void {
    if (contents.debugger.isAttached()) return;
    contents.debugger.attach("1.3");
  }

  async #applyColorScheme(tab: Tab): Promise<void> {
    const contents = tab.contents;
    if (!alive(contents)) return;
    try {
      this.#attachDebugger(contents);
      await contents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features:
          tab.colorScheme === "system"
            ? []
            : [{ name: "prefers-color-scheme", value: tab.colorScheme }],
      });
      if (tab.colorScheme === "system" && !tab.screencasting) contents.debugger.detach();
    } catch {
      // DevTools owns the debugger, or the guest went away mid-call. The
      // override is cosmetic; the page still renders.
    }
  }

  #onDebuggerMessage(tab: Tab) {
    return (_event: unknown, method: string, params: Record<string, unknown>) => {
      if (method !== "Page.screencastFrame" || !tab.screencasting) return;
      const metadata = (params["metadata"] ?? {}) as { deviceWidth?: number; deviceHeight?: number };
      this.emit("frame", {
        tabId: tab.tabId,
        data: String(params["data"] ?? ""),
        width: metadata.deviceWidth ?? 0,
        height: metadata.deviceHeight ?? 0,
        receivedAt: nowIso(),
      } satisfies PreviewScreencastFrame);
      // Chrome sends no further frames until the last one is acknowledged.
      const contents = tab.contents;
      if (alive(contents) && contents.debugger.isAttached()) {
        void contents.debugger
          .sendCommand("Page.screencastFrameAck", { sessionId: params["sessionId"] })
          .catch(() => undefined);
      }
    };
  }

  #stopScreencast(tab: Tab): void {
    if (!tab.screencasting) return;
    tab.screencasting = false;
    const contents = tab.contents;
    if (!alive(contents) || !contents.debugger.isAttached()) return;
    void contents.debugger.sendCommand("Page.stopScreencast").catch(() => undefined);
    contents.debugger.removeAllListeners("message");
    if (tab.colorScheme === "system") {
      try {
        contents.debugger.detach();
      } catch {
        // Already gone.
      }
    }
  }

  #state(tabId: string): PreviewTabState | null {
    const tab = this.#tabs.get(tabId);
    if (!tab) return null;
    return {
      tabId,
      webContentsId: alive(tab.contents) ? tab.contents.id : null,
      navStatus: tab.navStatus,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      zoomFactor: tab.zoomFactor,
      // Neither is wired in loop's shell: there is no pop-out window, and no
      // agent drives the browser, so the tab is always the human's.
      pictureInPicture: false,
      colorScheme: tab.colorScheme,
      controller: "none",
      updatedAt: nowIso(),
    };
  }

  #emit(tabId: string): void {
    const state = this.#state(tabId);
    if (state) this.emit("state", state);
  }

  async #artifacts(): Promise<string> {
    if (this.#artifactDirectory) return this.#artifactDirectory;
    const directory = join(app.getPath("temp"), "loop-preview");
    await mkdir(directory, { recursive: true });
    this.#artifactDirectory = directory;
    return directory;
  }
}
