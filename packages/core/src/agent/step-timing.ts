/**
 * Wall-clock bookkeeping for one turn's steps — the source of the `timing`
 * field on assistant entries (see StepTiming in ../types).
 *
 * The AI SDK measures the step itself: the step result's `performance` has
 * the step's total, the model's share and the time to first output, and the
 * onToolExecution* callbacks fire inside the SDK around each execute(). This
 * class only adds absolute anchors — a step's end is the onStepEnd instant,
 * everything else is that minus the SDK's durations — so nothing here reads
 * the turn's stream-consumer loop, whose lag can't skew a bar.
 *
 * The one exception is a step that never gets a step result (abort, stream
 * death): that one is anchored on onStepStart and closed at the instant the
 * caller asks, with the tools still in flight left open.
 */
import type { StepTiming, ToolTiming } from "../types";

/** The slice of the AI SDK's StepResult that timing reads. `performance` is
 * measured inside the SDK, performance.now() based (fractional ms). */
export interface SdkStepTimingFields {
    toolCalls?: ReadonlyArray<{ toolCallId: string }>;
    performance?: {
        stepTimeMs?: number;
        responseTimeMs?: number;
        timeToFirstOutputMs?: number;
        toolExecutionMs?: Record<string, number>;
    };
}

export class StepTimingRecorder {
    /** Tools by id; a step claims its own when it closes, and whatever is
     * left is the aborted step's in-flight set. */
    private readonly liveTools = new Map<string, ToolTiming>();
    private stepStartedAt = 0;
    private firstOutputAt = 0;
    /** Backoff waited out before the next step (stream resume) — reported on
     * that step, apart from its model bar, because it's a different cause. */
    private pendingRetryWaitMs = 0;

    constructor(private readonly now: () => number = Date.now) {}

    /** SDK onStepStart. */
    stepStarted(): void {
        this.stepStartedAt = this.now();
        this.firstOutputAt = 0;
    }

    /** First streamed part of the step in flight, as seen by the consumer.
     * Only the aborted-step path reads it; idempotent within a step. */
    outputSeen(): void {
        if (this.firstOutputAt === 0) this.firstOutputAt = this.now();
    }

    /** SDK onToolExecutionStart. */
    toolStarted(toolCallId: string, toolName: string): void {
        this.liveTools.set(toolCallId, { toolCallId, toolName, startedAt: this.now() });
    }

    /** SDK onToolExecutionEnd. Unknown ids are ignored (not ours to time). */
    toolEnded(toolCallId: string, error: boolean): void {
        const t = this.liveTools.get(toolCallId);
        if (!t) return;
        t.endedAt = this.now();
        if (error) t.error = true;
    }

    /** Wall time spent in stream-resume backoff, to be reported on the next
     * closed step. */
    retryWaited(ms: number): void {
        this.pendingRetryWaitMs += Math.max(0, ms);
    }

    /**
     * Close the step the SDK just finished (call from onStepEnd — that instant
     * IS the step's end). Anchors are rounded so the JSON stays integer epoch
     * ms like `ts`.
     */
    stepEnded(step: SdkStepTimingFields): StepTiming {
        const endedAt = this.now();
        const perf = step.performance;
        const startedAt =
            typeof perf?.stepTimeMs === "number" ? Math.round(endedAt - perf.stepTimeMs) : this.stepStartedAt || endedAt;
        const modelEndedAt =
            typeof perf?.responseTimeMs === "number"
                ? Math.min(endedAt, Math.round(startedAt + perf.responseTimeMs))
                : endedAt;
        const timing: StepTiming = { startedAt, modelEndedAt, endedAt };
        if (typeof perf?.timeToFirstOutputMs === "number") {
            timing.firstTokenAt = Math.min(modelEndedAt, Math.round(startedAt + perf.timeToFirstOutputMs));
        }
        const tools = this.claimTools(
            (step.toolCalls ?? []).map((c) => c.toolCallId),
            perf?.toolExecutionMs,
        );
        if (tools.length > 0) timing.tools = tools;
        if (this.pendingRetryWaitMs > 0) {
            timing.retryWaitMs = this.pendingRetryWaitMs;
            this.pendingRetryWaitMs = 0;
        }
        this.stepStartedAt = 0;
        return timing;
    }

    /**
     * Close a step that never got a step result (abort / stream death).
     * Undefined when no step was in flight — nothing to time.
     */
    closeInFlight(): StepTiming | undefined {
        if (!this.stepStartedAt) return undefined;
        const now = this.now();
        const timing: StepTiming = { startedAt: this.stepStartedAt, modelEndedAt: now, endedAt: now };
        if (this.firstOutputAt) timing.firstTokenAt = this.firstOutputAt;
        const tools = this.claimTools([...this.liveTools.keys()]);
        if (tools.length > 0) timing.tools = tools;
        this.stepStartedAt = 0;
        return timing;
    }

    private claimTools(ids: Iterable<string>, executionMs?: Record<string, number>): ToolTiming[] {
        const out: ToolTiming[] = [];
        for (const id of ids) {
            const t = this.liveTools.get(id);
            if (!t) continue;
            this.liveTools.delete(id);
            // onToolExecutionEnd normally set endedAt; the SDK's own per-tool
            // duration is the fallback if the callback was skipped.
            if (t.endedAt === undefined && typeof executionMs?.[id] === "number") {
                t.endedAt = Math.round(t.startedAt + executionMs[id]);
            }
            out.push(t);
        }
        return out;
    }
}
