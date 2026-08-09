import type { DesktopBridge } from "@loop/contracts";

/**
 * The update surface, wherever this build is hosted.
 *
 * `window.loop.updater` first: loop's desktop shell implements upstream's
 * update contract but hangs it off its own bridge (apps/desktop/src/preload.ts),
 * because exposing `window.desktopBridge` would flip `isElectron` and route
 * auth, connection setup and much else down upstream desktop paths this shell
 * has never had. Same reasoning, and same shape, as
 * `components/preview/previewBridge.ts`.
 *
 * `window.desktopBridge` stays as the fallback so this UI still works if it is
 * ever run inside the upstream host, and both are absent in the browser build —
 * where `hasDesktopUpdateBridge` is what keeps the pill off the screen, since
 * there is nothing there that could install anything.
 */
type DesktopUpdateActions = Pick<
  DesktopBridge,
  "downloadUpdate" | "installUpdate" | "checkForUpdate" | "openExternal"
>;

export const desktopUpdateBridge: DesktopUpdateActions | undefined =
  typeof window === "undefined"
    ? undefined
    : ((window.loop?.updater as DesktopUpdateActions | undefined) ?? window.desktopBridge);

export const hasDesktopUpdateBridge = desktopUpdateBridge !== undefined;
