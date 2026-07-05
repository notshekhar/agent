import { describe, expect, test } from "bun:test";
import { toolInputDeltaEvent, toolInputStartEvent } from "../src/agent/events";

// Regression: AI SDK v7 renamed the tool-input stream parts' fields
// (toolCallId → id, inputTextDelta → delta). The old names were read through
// casts, so every tool-input-start event carried toolCallId: undefined — the
// UI's `if (!toolCallId) return` then suppressed the pending tool box until
// the whole input had streamed. These pin the mapping for both SDK shapes.
describe("tool-input stream part mapping", () => {
    test("v7 shape: id and delta are read", () => {
        expect(toolInputStartEvent({ id: "call_1", toolName: "edit" })).toEqual({
            toolCallId: "call_1",
            toolName: "edit",
        });
        expect(toolInputDeltaEvent({ id: "call_1", delta: '{"path":"a' })).toEqual({
            toolCallId: "call_1",
            delta: '{"path":"a',
        });
    });

    test("legacy shape: toolCallId and inputTextDelta still work", () => {
        expect(toolInputStartEvent({ toolCallId: "call_2", toolName: "write" })).toEqual({
            toolCallId: "call_2",
            toolName: "write",
        });
        expect(toolInputDeltaEvent({ toolCallId: "call_2", inputTextDelta: "abc" })).toEqual({
            toolCallId: "call_2",
            delta: "abc",
        });
    });

    test("v7 fields win when both shapes are present; empty delta never undefined", () => {
        expect(toolInputStartEvent({ id: "new", toolCallId: "old", toolName: "write" }).toolCallId).toBe("new");
        expect(toolInputDeltaEvent({ id: "x" }).delta).toBe("");
    });
});
