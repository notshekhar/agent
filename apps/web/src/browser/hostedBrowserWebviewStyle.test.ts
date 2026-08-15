import { describe, expect, it } from "vite-plus/test";

import {
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("places an active webview on its presented surface", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: 30,
      pointerEvents: "auto",
    });
  });

  it("clips a floating webview to the mini-player frame", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        cornerRadius: 12,
        rect: { x: 12, y: 34, width: 360, height: 203 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toMatchObject({
      left: 12,
      top: 34,
      width: 360,
      height: 203,
      borderRadius: 12,
    });
  });

  /**
   * Offscreen alone does not stop a guest: Chromium only throttles a page it
   * considers hidden, so a parked webview left CSS-visible keeps painting and
   * running timers for as long as the tab exists.
   */
  it("puts an inactive webview to sleep while moving it offscreen", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 393, height: 852 },
    });

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 393,
      height: 852,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "hidden",
    });
  });

  /**
   * A guest being recorded or driven by automation is read while parked, and
   * CDP Runtime/Input commands stall against a hidden one — so it keeps its
   * offscreen position but stays awake.
   */
  it("keeps an inactive webview paintable while it is held live", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      keepLive: true,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 393, height: 852 },
    });

    expect(style).toMatchObject({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      visibility: "visible",
    });
  });

  /** keepLive is about parked guests; an active one is on screen regardless. */
  it("does not mark an active webview's visibility either way", () => {
    for (const keepLive of [true, false]) {
      expect(
        resolveHostedBrowserWebviewWrapperStyle({
          active: true,
          keepLive,
          rect: { x: 12, y: 34, width: 800, height: 600 },
          hiddenSize: { width: 1280, height: 800 },
        }),
      ).not.toHaveProperty("visibility");
    }
  });
});
