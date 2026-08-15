import type { ScopedThreadRef } from "@loop/contracts";
import { scopedThreadKey } from "@loop/runtime/environment";
import { create } from "zustand";

/**
 * Which threads are currently being driven by preview automation.
 *
 * An inactive preview tab is parked offscreen, and parking it is what lets
 * Chromium treat the guest as hidden and stop running its timers and frames.
 * But automation reads a guest that is not on screen — `currentStatus` measures
 * the rendered viewport of a tab whose `visible` is false — and a hidden guest
 * stalls those CDP Runtime/Input calls. So a tab under automation has to stay
 * awake even while parked.
 *
 * Held per thread rather than per tab because a request resolves its target tab
 * several branches deep, while the thread is known before any of that: holding
 * the thread's tabs awake for the (short, rare) life of a request is both
 * simpler and safe in the direction that matters — over-holding costs a little
 * battery, under-holding breaks automation.
 */
interface PreviewAutomationHoldStoreState {
  /** Outstanding holds per thread. Nested requests are why this counts. */
  readonly countByThreadKey: Readonly<Record<string, number>>;
  readonly acquire: (threadKey: string) => void;
  readonly release: (threadKey: string) => void;
}

const usePreviewAutomationHoldStore = create<PreviewAutomationHoldStoreState>()((set) => ({
  countByThreadKey: {},
  acquire: (threadKey) =>
    set((state) => ({
      countByThreadKey: {
        ...state.countByThreadKey,
        [threadKey]: (state.countByThreadKey[threadKey] ?? 0) + 1,
      },
    })),
  release: (threadKey) =>
    set((state) => {
      const next = (state.countByThreadKey[threadKey] ?? 0) - 1;
      if (next > 0) {
        return { countByThreadKey: { ...state.countByThreadKey, [threadKey]: next } };
      }
      // Drop the key rather than keeping a zero, so an idle app holds an empty
      // record and every consumer reads the same `false`.
      const { [threadKey]: _dropped, ...rest } = state.countByThreadKey;
      return { countByThreadKey: rest };
    }),
}));

/**
 * Keep this thread's preview guests awake until the returned release is called.
 * Release is idempotent, so a `finally` that runs twice cannot leak a hold.
 */
export function holdPreviewAutomation(threadRef: ScopedThreadRef): () => void {
  const threadKey = scopedThreadKey(threadRef);
  usePreviewAutomationHoldStore.getState().acquire(threadKey);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    usePreviewAutomationHoldStore.getState().release(threadKey);
  };
}

/** Whether automation is currently driving this thread's preview tabs. */
export function readPreviewAutomationHold(threadRef: ScopedThreadRef): boolean {
  const threadKey = scopedThreadKey(threadRef);
  return (usePreviewAutomationHoldStore.getState().countByThreadKey[threadKey] ?? 0) > 0;
}

/** The reactive form of {@link readPreviewAutomationHold}. */
export function usePreviewAutomationHold(threadRef: ScopedThreadRef): boolean {
  const threadKey = scopedThreadKey(threadRef);
  return usePreviewAutomationHoldStore(
    (state) => (state.countByThreadKey[threadKey] ?? 0) > 0,
  );
}
