import { describe, expect, it } from "vite-plus/test";
import {
  getAnchoredTurnMetrics,
  getRowBottom,
  pointerIsOnVerticalScrollbar,
  timelineEndLossIsUserDriven,
} from "./timelineScrollAnchoring";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timeline scroll anchoring", () => {
  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });

  it("treats the active turn as fitting when it fits above the composer", () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it("targets the real row end instead of any temporary reserved tail", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });

  it("reports overflow only for the current anchored turn", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 300],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(580);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(true);
  });

  it("returns the minimal positive scroll delta needed to reveal the turn end", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 360],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(1540);
    expect(metrics?.visibleUsableBottom).toBe(1464);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
  });

  it("subtracts composer height from usable viewport height", () => {
    const state = buildState({
      positions: [0, 300],
      sizes: [120, 470],
      scrollLength: 700,
    });

    const withoutComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 0,
      anchorOffset: 16,
    });
    const withComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 220,
      anchorOffset: 16,
    });

    expect(withoutComposer?.overflowsUsableViewport).toBe(false);
    expect(withComposer?.overflowsUsableViewport).toBe(true);
  });
});

describe("timelineEndLossIsUserDriven", () => {
  it("keeps following when content, not the reader, moved the end away", () => {
    // What a send looks like: the optimistic row lands and the composer
    // collapses to one line, both of which push the end past the viewport
    // while the follow generation still matches.
    expect(
      timelineEndLossIsUserDriven({
        liveFollowUserScrollGeneration: 3,
        userScrollGeneration: 3,
      }),
    ).toBe(false);
  });

  it("hands the view back once a gesture has bumped the generation", () => {
    expect(
      timelineEndLossIsUserDriven({
        liveFollowUserScrollGeneration: null,
        userScrollGeneration: 4,
      }),
    ).toBe(true);
  });

  it("hands the view back when a stale follow generation is left armed", () => {
    expect(
      timelineEndLossIsUserDriven({
        liveFollowUserScrollGeneration: 3,
        userScrollGeneration: 4,
      }),
    ).toBe(true);
  });
});

describe("pointerIsOnVerticalScrollbar", () => {
  const box = { right: 800, width: 500, clientWidth: 485 };

  it("counts a press inside the reserved gutter", () => {
    expect(pointerIsOnVerticalScrollbar({ ...box, clientX: 790 })).toBe(true);
    expect(pointerIsOnVerticalScrollbar({ ...box, clientX: 785 })).toBe(true);
  });

  it("leaves the transcript itself clickable", () => {
    // Selecting text in a reply or opening a tool row must not stop follow.
    expect(pointerIsOnVerticalScrollbar({ ...box, clientX: 784 })).toBe(false);
    expect(pointerIsOnVerticalScrollbar({ ...box, clientX: 400 })).toBe(false);
  });

  it("declines to guess when overlay scrollbars reserve no gutter", () => {
    expect(
      pointerIsOnVerticalScrollbar({ right: 800, width: 500, clientWidth: 500, clientX: 799 }),
    ).toBe(false);
  });
});
