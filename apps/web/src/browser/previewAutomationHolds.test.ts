import { type EnvironmentId, ThreadId } from "@loop/contracts";
import { scopeThreadRef } from "@loop/runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { holdPreviewAutomation, readPreviewAutomationHold } from "./previewAutomationHolds";

const threadRef = (threadId: string) =>
  scopeThreadRef("env-1" as EnvironmentId, ThreadId.make(threadId));

describe("preview automation holds", () => {
  it("holds a thread's guests awake for the life of a request", () => {
    const thread = threadRef("thread-hold");
    expect(readPreviewAutomationHold(thread)).toBe(false);

    const release = holdPreviewAutomation(thread);
    expect(readPreviewAutomationHold(thread)).toBe(true);

    release();
    expect(readPreviewAutomationHold(thread)).toBe(false);
  });

  /** Concurrent requests overlap; the last one out turns the lights off. */
  it("keeps the hold until every overlapping request releases", () => {
    const thread = threadRef("thread-overlap");
    const first = holdPreviewAutomation(thread);
    const second = holdPreviewAutomation(thread);

    first();
    expect(readPreviewAutomationHold(thread)).toBe(true);

    second();
    expect(readPreviewAutomationHold(thread)).toBe(false);
  });

  /** A `finally` can run more than once; a double release must not underflow
      the count and strand a later request's hold. */
  it("ignores a repeated release", () => {
    const thread = threadRef("thread-double-release");
    const release = holdPreviewAutomation(thread);
    release();
    release();

    const second = holdPreviewAutomation(thread);
    expect(readPreviewAutomationHold(thread)).toBe(true);
    second();
    expect(readPreviewAutomationHold(thread)).toBe(false);
  });

  it("does not hold guests awake for an unrelated thread", () => {
    const held = threadRef("thread-held");
    const other = threadRef("thread-other");
    const release = holdPreviewAutomation(held);

    expect(readPreviewAutomationHold(other)).toBe(false);
    release();
  });
});
