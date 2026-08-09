import type { DesktopPreviewBridge } from "@loop/contracts";

/**
 * Module-level handle to the desktop preview bridge.
 *
 * Resolved once at import time so React hooks don't pay for repeated lookups
 * on every render. `null` on the web build where there's no Electron host.
 *
 * `window.loop.preview` first: loop's shell implements upstream's preview
 * contract but hangs it off its own bridge (apps/desktop/src/preload.ts),
 * because exposing `window.desktopBridge` would flip `isElectron` and send
 * auth, connection setup and the updater down upstream desktop paths this
 * shell has never had. `window.desktopBridge?.preview` stays as the fallback
 * so the upstream host, if this UI is ever run inside one, still works.
 */
export const previewBridge =
  typeof window === "undefined"
    ? null
    : ((window.loop?.preview as DesktopPreviewBridge | undefined) ??
      window.desktopBridge?.preview ??
      null);
