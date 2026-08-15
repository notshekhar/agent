export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

/**
 * Whether losing the live edge means the user asked to leave it.
 *
 * The list reports "no longer at the end" for two very different reasons, and
 * they must not share a code path. A scroll gesture is the user reading back;
 * an optimistic row landing, streamed text growing a row, or the composer
 * changing height all push the end past the viewport with nobody touching the
 * mouse. Treating the second kind as the first is what stranded the transcript
 * after a send: follow mode was torn down one frame before the effect that
 * would have re-pinned it ran, so it read the teardown and gave up.
 *
 * A gesture bumps `userScrollGeneration` and clears the follow generation, so
 * the two disagreeing is the only honest signal that this was the user.
 */
export function timelineEndLossIsUserDriven(input: {
  readonly liveFollowUserScrollGeneration: number | null;
  readonly userScrollGeneration: number;
}): boolean {
  return input.liveFollowUserScrollGeneration !== input.userScrollGeneration;
}

/**
 * Whether a pointer landed on the vertical scrollbar rather than the transcript.
 *
 * Dragging the scrollbar is a scroll gesture and has to opt out of follow mode,
 * but a bare `pointerdown` on the scroll node cannot stand in for it — that
 * fires when you click a tool row or select text in a reply, and stopping the
 * stream because someone highlighted a word is the bug this exists to avoid.
 * The gutter is the part of the box `clientWidth` does not cover; overlay
 * scrollbars reserve nothing, so this correctly declines to guess there.
 */
export function pointerIsOnVerticalScrollbar(input: {
  readonly clientX: number;
  readonly right: number;
  readonly width: number;
  readonly clientWidth: number;
}): boolean {
  const gutter = input.width - input.clientWidth;
  if (gutter <= 0) {
    return false;
  }
  return input.clientX >= input.right - gutter;
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}
