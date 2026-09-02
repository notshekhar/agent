import { describe, expect, test } from "bun:test";
import { StepTimingRecorder } from "../src/agent/step-timing";

/** A clock that returns the queued instants in order, then holds the last. */
function clock(...instants: number[]) {
    let i = 0;
    return () => instants[Math.min(i++, instants.length - 1)];
}

describe("StepTimingRecorder", () => {
    test("a finished step is anchored on its end and split by the SDK's durations", () => {
        const rec = new StepTimingRecorder(clock(10_000));
        const t = rec.stepEnded({
            performance: { stepTimeMs: 4_000.4, responseTimeMs: 1_500.6, timeToFirstOutputMs: 300.2 },
        });
        expect(t).toEqual({ startedAt: 6_000, firstTokenAt: 6_300, modelEndedAt: 7_501, endedAt: 10_000 });
        // integers only — the JSON stays epoch ms like `ts`
        for (const v of Object.values(t)) expect(Number.isInteger(v)).toBe(true);
    });

    test("tools are claimed by id, with the SDK duration as fallback for a missing end", () => {
        const rec = new StepTimingRecorder(clock(100, 200, 350, 1_000));
        rec.toolStarted("a", "ls"); // 100
        rec.toolStarted("b", "grep"); // 200
        rec.toolEnded("a", false); // 350
        rec.toolEnded("zzz", true); // unknown id: ignored
        const t = rec.stepEnded({
            toolCalls: [{ toolCallId: "a" }, { toolCallId: "b" }],
            performance: { stepTimeMs: 950, responseTimeMs: 50, toolExecutionMs: { b: 700.4 } },
        }); // 1_000
        expect(t.tools).toEqual([
            { toolCallId: "a", toolName: "ls", startedAt: 100, endedAt: 350 },
            { toolCallId: "b", toolName: "grep", startedAt: 200, endedAt: 900 },
        ]);
    });

    test("a step only claims its own tools; the rest stay for the next close", () => {
        const rec = new StepTimingRecorder(clock(1, 2, 3, 4, 5));
        rec.toolStarted("mine", "a");
        rec.toolStarted("theirs", "b");
        const first = rec.stepEnded({ toolCalls: [{ toolCallId: "mine" }] });
        expect(first.tools?.map((x) => x.toolCallId)).toEqual(["mine"]);
        rec.stepStarted();
        const second = rec.closeInFlight();
        expect(second?.tools?.map((x) => x.toolCallId)).toEqual(["theirs"]);
        expect(second?.tools?.[0].endedAt).toBeUndefined();
    });

    test("an errored tool is marked", () => {
        const rec = new StepTimingRecorder(clock(1, 2, 3));
        rec.toolStarted("x", "bash");
        rec.toolEnded("x", true);
        expect(rec.stepEnded({ toolCalls: [{ toolCallId: "x" }] }).tools?.[0].error).toBe(true);
    });

    test("retry wait is reported once, on the next closed step", () => {
        const rec = new StepTimingRecorder(clock(50, 60));
        rec.retryWaited(700);
        rec.retryWaited(300);
        expect(rec.stepEnded({}).retryWaitMs).toBe(1_000);
        expect(rec.stepEnded({}).retryWaitMs).toBeUndefined();
    });

    test("an in-flight step closes on the onStepStart anchor with the consumer's first output", () => {
        const rec = new StepTimingRecorder(clock(1_000, 1_400, 2_000));
        rec.stepStarted(); // 1_000
        rec.outputSeen(); // 1_400
        rec.outputSeen(); // idempotent: the first output stays 1_400
        const t = rec.closeInFlight(); // 2_000
        expect(t).toEqual({ startedAt: 1_000, firstTokenAt: 1_400, modelEndedAt: 2_000, endedAt: 2_000 });
        // and nothing is in flight afterwards
        expect(rec.closeInFlight()).toBeUndefined();
    });

    test("nothing in flight → nothing to time", () => {
        expect(new StepTimingRecorder(clock(1)).closeInFlight()).toBeUndefined();
    });

    test("without SDK performance, a closed step falls back to the onStepStart anchor", () => {
        const rec = new StepTimingRecorder(clock(500, 900));
        rec.stepStarted(); // 500
        expect(rec.stepEnded({})).toEqual({ startedAt: 500, modelEndedAt: 900, endedAt: 900 });
    });
});
