import { useSyncExternalStore } from "react";

/** Whether the document is currently visible to the user.
    One module-level `visibilitychange` subscription feeds every consumer
    through useSyncExternalStore, so gating N polls on visibility costs one
    listener rather than N — and every gated poll flips on the same value in the
    same tick.

    Use this to stop recurring work that only exists to keep something on screen
    current. A backgrounded window still runs its timers (Chromium throttles
    them to roughly 1/s rather than stopping them), and work those timers
    dispatch outside the renderer — a `git diff` per tick, say — is not
    throttled at all. */

function getSnapshot(): boolean {
  return document.visibilityState === "visible";
}

/** The server has no document, and prerendered output should read as visible
    so a poll is live on hydration rather than waiting for the first event. */
function getServerSnapshot(): boolean {
  return true;
}

const listeners = new Set<() => void>();

function handleVisibilityChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
