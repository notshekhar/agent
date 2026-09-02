/**
 * /trace — the session as a timing-and-cost model: turns, the steps inside
 * them, the tools inside those, with tokens and dollars per step.
 *
 * Pure transform over the session's active branch, JSON-serializable so the
 * HTML page (see ./html.ts) can embed it and render client-side.
 *
 * Timing provenance is explicit on every step, because the two sources are
 * not equally honest:
 *
 *   recorded  the turn loop stamped `timing` on the entry (StepTiming): the
 *             step's start, first token, model end, end, and each tool's own
 *             start/end. Real bars.
 *   derived   older entries have only `ts`, which is the step's END (a step's
 *             messages persist in one batch after its tools ran). The step's
 *             wall time is then "previous anchor → ts": model + tools, no
 *             split. The page draws that as one hatched bar, never as bars
 *             it does not have.
 *   none      no earlier anchor in the turn to measure from (legacy sessions
 *             without a user entry). The page writes "timing not recorded".
 */
import { extractMessageText, type Session } from "../sessions/session";
import type { Entry, StepTiming } from "../types";
import { OUTPUT_CAP, isErrorOutput, oneLine, partsOf, toolInputLine, toolOutputText } from "./content";
import { addUsage, emptyUsage, traceUsage, type TraceUsage } from "./usage";

export type { TraceUsage } from "./usage";

export interface TraceSubagent {
    agent: string;
    prompt: string;
    result: string;
    steps?: number;
    durationMs?: number;
    usage?: TraceUsage;
}

export interface TraceTool {
    toolCallId: string;
    name: string;
    /** One-line rendering of the call's input. */
    input: string;
    /** The result text, capped (see OUTPUT_CAP); absent if never returned. */
    output?: string;
    outputChars?: number;
    error: boolean;
    /** Only when the step's timing is recorded. `endedAt` absent = cut off. */
    timing?: { startedAt: number; endedAt?: number };
    /** A `task` call that ran a subagent — its own persisted run. */
    subagent?: TraceSubagent;
}

export type TraceStepTiming =
    | {
          kind: "recorded";
          startedAt: number;
          firstTokenAt?: number;
          modelEndedAt: number;
          endedAt: number;
          retryWaitMs?: number;
      }
    | { kind: "derived"; startedAt: number; endedAt: number }
    | { kind: "none"; endedAt: number };

export interface TraceStep {
    /** 1-based within the turn. */
    index: number;
    entryId?: string;
    model?: string;
    text: string;
    reasoning: string;
    reasoningMs?: number[];
    tools: TraceTool[];
    usage?: TraceUsage;
    interrupted: boolean;
    timing: TraceStepTiming;
}

export interface TraceEvent {
    ts: number;
    kind: "compact" | "model-change" | "branch-summary";
    label: string;
}

export interface TraceTurn {
    /** 1-based. */
    index: number;
    user: { text: string; ts: number };
    steps: TraceStep[];
    /** Compactions / model switches that happened during this turn. */
    events: TraceEvent[];
    startedAt: number;
    endedAt: number;
    usage: TraceUsage;
    /** Every step in the turn has recorded timing. */
    fullyRecorded: boolean;
}

export interface TraceTotals {
    turns: number;
    steps: number;
    tools: number;
    wallMs: number;
    usage: TraceUsage;
}

export interface TraceCoverage {
    recorded: number;
    derived: number;
    none: number;
}

export interface TraceModel {
    session: {
        id: string;
        name?: string;
        model: string;
        provider: string;
        cwd: string;
        createdAt: number;
    };
    generatedAt: number;
    turns: TraceTurn[];
    totals: TraceTotals;
    coverage: TraceCoverage;
}

type MessageEntry = Extract<Entry, { type: "message" }>;
type SubagentEntry = Extract<Entry, { type: "subagent" }>;

export function sessionToTrace(session: Session): TraceModel {
    const builder = new TraceBuilder(session.info.model);
    for (const entry of session.getBranch()) builder.add(entry);
    const { turns, totals, coverage } = builder.finish();
    const name = session.getName();
    return {
        session: {
            id: session.id,
            ...(name ? { name } : {}),
            model: session.lastModel() || session.info.model,
            provider: session.info.provider,
            cwd: session.info.cwd,
            createdAt: session.info.createdAt,
        },
        generatedAt: Date.now(),
        turns,
        totals,
        coverage,
    };
}

/**
 * Folds the branch's entries into turns. One method per entry kind; the
 * state between them is the open turn, its latest step, and the anchor a
 * `derived` step measures from.
 */
class TraceBuilder {
    private readonly turns: TraceTurn[] = [];
    private readonly coverage: TraceCoverage = { recorded: 0, derived: 0, none: 0 };
    private turn: TraceTurn | undefined;
    private step: TraceStep | undefined;
    /** Last known instant inside the open turn. The user entry sets it;
     * every step's end advances it. Undefined = nothing to measure from. */
    private anchor: number | undefined;

    constructor(private model: string) {}

    add(e: Entry): void {
        switch (e.type) {
            case "message":
                if (e.role === "user") this.openTurn(extractMessageText(e.content), e.ts);
                else if (e.role === "assistant") this.addStep(e);
                else this.addToolResults(e);
                return;
            case "subagent":
                this.addSubagent(e);
                return;
            case "model-change":
                if (e.to) this.model = e.to;
                this.addEvent(e.ts, "model-change", `model → ${e.to}`);
                return;
            case "compact":
                this.addEvent(
                    e.ts,
                    "compact",
                    `context compacted ${e.tokensBefore.toLocaleString()} → ${e.tokensAfter.toLocaleString()} tokens`,
                );
                return;
            case "branch-summary":
                this.addEvent(e.ts, "branch-summary", "branch summarized");
                return;
            default:
                return;
        }
    }

    finish(): { turns: TraceTurn[]; totals: TraceTotals; coverage: TraceCoverage } {
        this.closeTurn();
        const totals: TraceTotals = { turns: this.turns.length, steps: 0, tools: 0, wallMs: 0, usage: emptyUsage() };
        for (const t of this.turns) {
            totals.steps += t.steps.length;
            totals.tools += t.steps.reduce((n, s) => n + s.tools.length, 0);
            totals.wallMs += Math.max(0, t.endedAt - t.startedAt);
            addUsage(totals.usage, t.usage);
        }
        return { turns: this.turns, totals, coverage: this.coverage };
    }

    // ---- turns -------------------------------------------------------------

    private openTurn(text: string, ts: number): TraceTurn {
        this.closeTurn();
        this.turn = {
            index: this.turns.length + 1,
            user: { text, ts },
            steps: [],
            events: [],
            startedAt: ts,
            endedAt: ts,
            usage: emptyUsage(),
            fullyRecorded: false,
        };
        this.anchor = ts;
        return this.turn;
    }

    private closeTurn(): void {
        const t = this.turn;
        if (!t) return;
        t.fullyRecorded = t.steps.length > 0 && t.steps.every((s) => s.timing.kind === "recorded");
        this.turns.push(t);
        this.turn = undefined;
        this.step = undefined;
        this.anchor = undefined;
    }

    private addEvent(ts: number, kind: TraceEvent["kind"], label: string): void {
        this.turn?.events.push({ ts, kind, label });
    }

    // ---- steps -------------------------------------------------------------

    private addStep(e: MessageEntry): void {
        // An assistant entry with no user turn (legacy / import) opens an
        // anonymous turn — with no anchor, since nothing preceded it.
        let turn = this.turn;
        if (!turn) {
            turn = this.openTurn("", e.ts);
            this.anchor = undefined;
        }
        const model = e.model ?? this.model;
        const timing = stepTiming(e.timing, this.anchor, e.ts);
        this.coverage[timing.kind]++;
        const { text, reasoning, tools } = readAssistantContent(e);
        attachToolTimings(tools, e.timing);
        const usage = traceUsage(model, e.usage);

        const step: TraceStep = {
            index: turn.steps.length + 1,
            ...(e.id ? { entryId: e.id } : {}),
            model,
            text,
            reasoning,
            ...(e.reasoningMs ? { reasoningMs: e.reasoningMs } : {}),
            tools,
            ...(usage ? { usage } : {}),
            interrupted: e.interrupted === true,
            timing,
        };
        turn.steps.push(step);
        this.step = step;
        addUsage(turn.usage, usage);
        if (timing.kind === "recorded" && timing.startedAt < turn.startedAt) turn.startedAt = timing.startedAt;
        this.advance(timing.endedAt);
    }

    private addToolResults(e: MessageEntry): void {
        const step = this.step;
        if (!step) return;
        for (const p of partsOf(e.content)) {
            if (p.type !== "tool-result" || !p.toolCallId) continue;
            const tool = step.tools.find((x) => x.toolCallId === p.toolCallId);
            if (!tool) continue;
            const out = toolOutputText(p.output);
            tool.output = out.slice(0, OUTPUT_CAP);
            tool.outputChars = out.length;
            if (isErrorOutput(p.output)) tool.error = true;
        }
        this.advance(e.ts);
    }

    /** A subagent run attaches to the `task` call that launched it — rebuilt
     * from its timing if the transcript filtered the call — else to the step
     * in flight. Its spend is the turn's spend too. */
    private addSubagent(e: SubagentEntry): void {
        const step = this.step;
        if (!step) return;
        const usage = traceUsage(e.model ?? this.model, e.usage);
        const subagent: TraceSubagent = {
            agent: e.agent,
            prompt: e.prompt,
            result: e.result,
            ...(e.steps !== undefined ? { steps: e.steps } : {}),
            ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
            ...(usage ? { usage } : {}),
        };
        const existing = e.toolCallId ? step.tools.find((t) => t.toolCallId === e.toolCallId) : undefined;
        if (existing) {
            existing.name = "task";
            existing.subagent = subagent;
            if (!existing.input) existing.input = oneLine(e.prompt);
        } else {
            step.tools.push({
                toolCallId: e.toolCallId ?? `subagent-${e.ts}`,
                name: "task",
                input: oneLine(e.prompt),
                output: e.result.slice(0, OUTPUT_CAP),
                outputChars: e.result.length,
                error: false,
                subagent,
            });
        }
        if (this.turn) addUsage(this.turn.usage, usage);
    }

    /** Move the turn's end and the derived-timing anchor forward to `ts`. */
    private advance(ts: number): void {
        if (this.turn && ts > this.turn.endedAt) this.turn.endedAt = ts;
        this.anchor = Math.max(this.anchor ?? 0, ts);
    }
}

// ---- pure helpers ------------------------------------------------------------

function stepTiming(timing: StepTiming | undefined, anchor: number | undefined, ts: number): TraceStepTiming {
    if (timing) {
        return {
            kind: "recorded",
            startedAt: timing.startedAt,
            ...(timing.firstTokenAt !== undefined ? { firstTokenAt: timing.firstTokenAt } : {}),
            modelEndedAt: timing.modelEndedAt,
            endedAt: timing.endedAt,
            ...(timing.retryWaitMs ? { retryWaitMs: timing.retryWaitMs } : {}),
        };
    }
    if (anchor !== undefined && ts >= anchor) return { kind: "derived", startedAt: anchor, endedAt: ts };
    return { kind: "none", endedAt: ts };
}

function readAssistantContent(e: MessageEntry): { text: string; reasoning: string; tools: TraceTool[] } {
    if (typeof e.content === "string") return { text: e.content, reasoning: "", tools: [] };
    let text = "";
    let reasoning = "";
    const tools: TraceTool[] = [];
    for (const p of partsOf(e.content)) {
        if (p.type === "text") text += p.text ?? "";
        else if (p.type === "reasoning") reasoning += p.text ?? "";
        else if (p.type === "tool-call" && p.toolCallId) {
            tools.push({ toolCallId: p.toolCallId, name: p.toolName ?? "tool", input: toolInputLine(p.input), error: false });
        }
    }
    return { text, reasoning, tools };
}

/** Recorded per-tool bars, by id. A tool the transcript filtered (the `task`
 * call) still has one — surface it; the subagent entry fills in the rest. */
function attachToolTimings(tools: TraceTool[], timing: StepTiming | undefined): void {
    for (const tt of timing?.tools ?? []) {
        let tool = tools.find((x) => x.toolCallId === tt.toolCallId);
        if (!tool) {
            tool = { toolCallId: tt.toolCallId, name: tt.toolName || "tool", input: "", error: false };
            tools.push(tool);
        }
        tool.timing = { startedAt: tt.startedAt, ...(tt.endedAt !== undefined ? { endedAt: tt.endedAt } : {}) };
        if (tt.error) tool.error = true;
    }
}
