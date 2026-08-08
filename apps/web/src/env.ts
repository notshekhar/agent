/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.desktopBridge via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

/**
 * True in loop's own desktop shell.
 *
 * `isElectron` above tests upstream's `window.desktopBridge`, and loop's
 * preload does not expose that — it exposes `window.loop` and nothing else
 * (apps/desktop/src/preload.ts). So `isElectron` is **false inside the desktop
 * app**, which is correct for the upstream features that call desktopBridge
 * methods, and wrong for anything about the window itself: the macOS traffic
 * lights sat on top of the sidebar header until this told them apart.
 *
 * Rule of thumb: window chrome and drag regions ask this; anything that then
 * calls a `desktopBridge.*` method must keep asking `isElectron`.
 */
export const isDesktopShell = typeof window !== "undefined" && window.loop !== undefined;
