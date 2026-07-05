import type { TUI } from "@notshekhar/loop-tui";
import { subagentArgSummary } from "@notshekhar/loop-core";
import type { ChatHistory } from "./components/chat-history";
import { formatTaskDuration } from "./ui/tool-execution";

/** Subagent activity buffers are tail-capped — only the last slice renders. */
const MAX_BUFFER_BYTES = 6000;
/**
 * Subagent deltas arrive per token — rebuilding the tool box for each one burns
 * CPU for invisible frames. Dirty ids flush on this timer instead.
 */
const FLUSH_INTERVAL_MS = 50;

/** Live per-run stats behind the `tool · step N · 12s · $0.0123` title line. */
interface TaskLiveStats {
    startedAt: number;
    lastAction: string;
    steps?: number;
    usd?: number;
}

/**
 * Live subagent streaming for the task tool: activity renders inside the task
 * tool's box (keyed by the task toolCallId), coalesced behind a ~50ms timer.
 * The buffer is intentionally kept on subagent-finish — tool-result composes it
 * into the final display, then calls clear().
 */
export interface SubagentStream {
    /** A subagent invoked a tool — append a `> tool args` line. */
    onTool(toolCallId: string, toolName: string | undefined, input: unknown): void;
    /** A subagent emitted assistant text — append it to the buffer. */
    onDelta(toolCallId: string, text: string): void;
    /** A subagent step was billed — update the step/cost ticker in the title. */
    onStepUsage(toolCallId: string, steps: number | undefined, usd: number | undefined): void;
    /** Drop a finished subagent's buffer/status/dirty state. */
    clear(toolCallId: string): void;
    /** Turn ended (including aborts): drop all state and stop both timers —
     * an interrupted subagent never gets a tool-result to clear() it. */
    dispose(): void;
}

export function createSubagentStream(history: ChatHistory, tui: TUI): SubagentStream {
    const buffers = new Map<string, string>();
    const stats = new Map<string, TaskLiveStats>();
    const dirty = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    // 1s pulse while any task runs, so the elapsed-time part of the status
    // ticks even when the subagent is silent (long bash call, slow model).
    let elapsedTimer: ReturnType<typeof setInterval> | null = null;

    const statusFor = (s: TaskLiveStats): string => {
        const parts = [s.lastAction];
        if (s.steps) parts.push(`step ${s.steps}`);
        parts.push(formatTaskDuration(Date.now() - s.startedAt));
        if (s.usd !== undefined) parts.push(`$${s.usd.toFixed(4)}`);
        return parts.join(" · ");
    };

    const flush = (): void => {
        flushTimer = null;
        for (const id of dirty) {
            // A step can be billed before any output streams — update whichever
            // of buffer/status exists; a cleared (finished) id has neither.
            const buf = buffers.get(id);
            if (buf !== undefined) history.updateToolProgress(id, buf);
            const s = stats.get(id);
            if (s) history.setToolStatus(id, statusFor(s));
        }
        dirty.clear();
        tui.requestRender();
    };

    const queueRepaint = (id: string): void => {
        dirty.add(id);
        if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    };

    const statFor = (id: string): TaskLiveStats => {
        let s = stats.get(id);
        if (!s) {
            s = { startedAt: Date.now(), lastAction: "running" };
            stats.set(id, s);
            if (!elapsedTimer) {
                elapsedTimer = setInterval(() => {
                    for (const id of stats.keys()) dirty.add(id);
                    if (!flushTimer) flushTimer = setTimeout(flush, 0);
                }, 1000);
            }
        }
        return s;
    };

    const stopElapsedIfIdle = (): void => {
        if (stats.size === 0 && elapsedTimer) {
            clearInterval(elapsedTimer);
            elapsedTimer = null;
        }
    };

    return {
        onTool(toolCallId, toolName, input) {
            const prev = buffers.get(toolCallId) ?? "";
            const line = `> ${toolName ?? "tool"}${subagentArgSummary(input)}\n`;
            const next = `${prev}${prev && !prev.endsWith("\n") ? "\n" : ""}${line}`.slice(-MAX_BUFFER_BYTES);
            buffers.set(toolCallId, next);
            statFor(toolCallId).lastAction = toolName ?? "running";
            queueRepaint(toolCallId);
        },
        onDelta(toolCallId, text) {
            const next = ((buffers.get(toolCallId) ?? "") + text).slice(-MAX_BUFFER_BYTES);
            buffers.set(toolCallId, next);
            statFor(toolCallId).lastAction = "writing";
            queueRepaint(toolCallId);
        },
        onStepUsage(toolCallId, steps, usd) {
            const s = statFor(toolCallId);
            if (steps !== undefined) s.steps = steps;
            if (usd !== undefined) s.usd = usd;
            queueRepaint(toolCallId);
        },
        clear(toolCallId) {
            buffers.delete(toolCallId);
            stats.delete(toolCallId);
            dirty.delete(toolCallId);
            stopElapsedIfIdle();
        },
        dispose() {
            buffers.clear();
            stats.clear();
            dirty.clear();
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            stopElapsedIfIdle();
        },
    };
}
