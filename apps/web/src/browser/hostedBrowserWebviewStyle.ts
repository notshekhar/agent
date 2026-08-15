import type { BrowserSurfaceRect } from "./browserSurfaceStore";

export interface HostedBrowserWebviewSize {
  readonly width: number;
  readonly height: number;
}

export interface HostedBrowserWebviewWrapperStyle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly pointerEvents: "auto" | "none";
  readonly borderRadius?: number;
  readonly visibility?: "visible" | "hidden";
}

export const HIDDEN_BROWSER_WEBVIEW_OFFSET = -100_000;

export function resolveHostedBrowserWebviewWrapperStyle(input: {
  readonly active: boolean;
  readonly cornerRadius?: number;
  readonly rect: BrowserSurfaceRect | null;
  readonly hiddenSize: HostedBrowserWebviewSize;
  /**
   * Whether this guest must keep running while parked — it is being recorded,
   * or automation is driving it. See the `visibility` note below.
   */
  readonly keepLive?: boolean;
}): HostedBrowserWebviewWrapperStyle {
  const { active, cornerRadius = 0, hiddenSize, keepLive = false, rect } = input;
  if (active && rect) {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex: 30,
      pointerEvents: "auto",
      ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
    };
  }

  return {
    left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    width: hiddenSize.width,
    height: hiddenSize.height,
    zIndex: -1,
    pointerEvents: "none",
    // Visibility is what decides whether a parked guest keeps burning CPU.
    //
    // Offscreen is not hidden: a guest at these coordinates with
    // `visibility:visible` is still, as far as Chromium is concerned, on
    // screen. It runs rAF, services its timers at full rate, and keeps a
    // compositor busy — so a handful of background preview tabs cost about
    // what the same pages would cost open in a browser, forever. Hiding it
    // instead lets Chromium mark the page hidden and throttle all of that.
    //
    // The exception is a guest that is being read while parked. Automation
    // measures tabs whose `visible` is false (see `currentStatus`), and
    // Electron webviews can keep metadata alive under `visibility:hidden`
    // while CDP Runtime/Input commands stall — which breaks exactly that. So
    // those tabs, and tabs being recorded, stay awake; the rest sleep.
    visibility: keepLive ? "visible" : "hidden",
  };
}
