import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  closePreview,
  listPreviews,
  navigatePreview,
  openPreview,
  reportPreviewStatus,
  resetPreviewsForTest,
  resizePreview,
} from "./preview.ts";

const run = Effect.runPromise;
const THREAD = "01THREAD";

beforeEach(() => {
  resetPreviewsForTest();
});

describe("the browser panel's tabs", () => {
  it("opens an empty tab the user can type into", async () => {
    const tab = await run(openPreview({ threadId: THREAD }));
    expect(tab.navStatus._tag).toBe("Idle");
    expect(tab.canGoBack).toBe(false);
  });

  it("opens straight at a URL when given one", async () => {
    const tab = await run(openPreview({ threadId: THREAD, url: "http://localhost:3000/" }));
    expect(tab.navStatus).toMatchObject({ _tag: "Loading", url: "http://localhost:3000/" });
  });

  it("lists what is open, per process", async () => {
    await run(openPreview({ threadId: THREAD }));
    await run(openPreview({ threadId: THREAD }));
    const listed = await run(listPreviews());
    expect(listed.sessions).toHaveLength(2);
    expect(listed.serverEpoch).toMatch(/^loop-/);
  });

  it("bumps the revision on every change, so a stale list can be rejected", async () => {
    const before = (await run(listPreviews())).revision;
    await run(openPreview({ threadId: THREAD }));
    const after = (await run(listPreviews())).revision;
    expect(after).toBeGreaterThan(before);
  });

  it("navigating only ever says Loading — the webview reports the outcome", async () => {
    const tab = await run(openPreview({ threadId: THREAD }));
    const navigated = await run(
      navigatePreview({ threadId: THREAD, tabId: tab.tabId, url: "http://localhost:5173/" }),
    );
    expect(navigated.navStatus).toMatchObject({ _tag: "Loading" });

    await run(
      reportPreviewStatus({
        threadId: THREAD,
        tabId: tab.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "loop" } as never,
        canGoBack: true,
        canGoForward: false,
      }),
    );
    // reportStatus returns void, so the settled state is read back from list.
    const settled = (await run(listPreviews())).sessions.find((s) => s.tabId === tab.tabId);
    expect(settled?.navStatus).toMatchObject({ _tag: "Success", title: "loop" });
    expect(settled?.canGoBack).toBe(true);
  });

  it("remembers a resized viewport", async () => {
    const tab = await run(openPreview({ threadId: THREAD }));
    const resized = await run(
      resizePreview({
        threadId: THREAD,
        tabId: tab.tabId,
        viewport: { _tag: "freeform", width: 390, height: 844 } as never,
      }),
    );
    expect(resized.viewport).toMatchObject({ _tag: "freeform", width: 390 });
  });

  it("closes a tab", async () => {
    const tab = await run(openPreview({ threadId: THREAD }));
    await run(closePreview({ threadId: THREAD, tabId: tab.tabId }));
    expect((await run(listPreviews())).sessions).toHaveLength(0);
  });

  it("closes every tab on the thread when no tab is named", async () => {
    // What closing the panel does.
    await run(openPreview({ threadId: THREAD }));
    await run(openPreview({ threadId: THREAD }));
    await run(openPreview({ threadId: "01OTHER" }));
    await run(closePreview({ threadId: THREAD }));
    const left = (await run(listPreviews())).sessions;
    expect(left.map((s) => s.threadId)).toEqual(["01OTHER"]);
  });

  it("fails an unknown tab with the error the panel knows how to show", async () => {
    // A silent no-op would leave the panel waiting on a snapshot forever.
    await expect(
      run(navigatePreview({ threadId: THREAD, tabId: "gone", url: "http://x/" })),
    ).rejects.toThrow(/Unknown preview session/);
  });

  it("keeps one thread's tabs out of another's", async () => {
    const mine = await run(openPreview({ threadId: THREAD }));
    await run(openPreview({ threadId: "01OTHER" }));
    await expect(
      run(closePreview({ threadId: "01OTHER", tabId: mine.tabId })),
    ).rejects.toThrow(/Unknown preview session/);
  });
});
