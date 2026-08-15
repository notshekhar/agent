/**
 * How a one-shot run reports itself.
 *
 * Three formats over one turn emitter. `text` is what a person reads: the
 * model's words on stdout, activity on stderr. `json` and `stream-json` exist
 * because a script had no honest way to read a run — the only structure was
 * `[tool:name] {...}` lines scraped out of stderr, which is neither stable nor
 * complete.
 *
 * The invariant that makes the machine formats usable: in a JSON format
 * **stdout carries JSON and nothing else**. Model text, hook output, and
 * terminal escape sequences all become events or fields instead of being
 * written through — a hook emitting a colour code must not corrupt the parse.
 */
import { TURN_EVENT_NAMES, type CostBreakdown, type TurnEmitter, type UsageBlock } from "@notshekhar/loop-core";
import type { OutputFormat } from "../spec";

/** What the run knows about itself before the first token. */
export interface RunContext {
    sessionId: string;
    model: string;
    cwd: string;
}

/** What the run knows once it is over. */
export interface RunResult {
    /** False when the turn emitted an error part (CI wants a nonzero exit). */
    ok: boolean;
    cost: CostBreakdown;
    durationMs: number;
}

export interface PrintReporter {
    /** Subscribe to the turn's events. Called once, before the turn starts. */
    attach(emitter: TurnEmitter): void;
    /** Announce the session. Its id is what `--session` resumes. */
    begin(ctx: RunContext): void;
    /** Final summary in this format's shape. */
    end(result: RunResult): void;
    /** True once an error event has been seen. */
    readonly errored: boolean;
}

/**
 * JSON.stringify that survives what an event payload can actually hold.
 * An Error stringifies to `{}` by default — which is the one payload shape
 * the `error` event is most likely to carry.
 */
function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => jsonSafe(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v, seen);
    return out;
}

function writeLine(obj: unknown): void {
    process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Shared bookkeeping: the reply text, the step count, and whether it failed. */
abstract class BaseReporter implements PrintReporter {
    protected text = "";
    protected steps = 0;
    protected errors: unknown[] = [];
    protected ctx: RunContext | undefined;

    get errored(): boolean {
        return this.errors.length > 0;
    }

    abstract attach(emitter: TurnEmitter): void;
    abstract begin(ctx: RunContext): void;
    abstract end(result: RunResult): void;

    /** The counters every format reports, wired the same way in each. */
    protected track(emitter: TurnEmitter): void {
        emitter.on("text-delta", (t: string) => {
            this.text += t;
        });
        emitter.on("step-usage", () => {
            this.steps++;
        });
        emitter.on("error", (err: unknown) => {
            this.errors.push(err);
        });
    }

    protected resultObject(result: RunResult): Record<string, unknown> {
        return {
            type: "result",
            is_error: !result.ok,
            session_id: this.ctx?.sessionId,
            model: this.ctx?.model,
            cwd: this.ctx?.cwd,
            // The reply text, already assembled — the field a script wants.
            result: this.text,
            steps: this.steps,
            duration_ms: result.durationMs,
            usd: result.cost.usd,
            usage: {
                input_tokens: result.cost.inputTokens,
                output_tokens: result.cost.outputTokens,
                cached_input_tokens: result.cost.cachedInputTokens,
            },
            // Present only when something went wrong, so `errors` in the output
            // always means there were some.
            ...(this.errors.length ? { errors: this.errors.map((e) => jsonSafe(e)) } : {}),
        };
    }
}

/** The human format: unchanged behaviour, plus the session id. */
class TextReporter extends BaseReporter {
    attach(emitter: TurnEmitter): void {
        this.track(emitter);
        emitter.on("text-delta", (t: string) => process.stdout.write(t));
        emitter.on("tool-call", (part: { toolName?: string; input?: unknown }) => {
            process.stderr.write(`\n[tool:${part.toolName}] ${JSON.stringify(part.input)}\n`);
        });
        emitter.on("tool-input-updated", (e: { toolName?: string; input?: unknown }) => {
            process.stderr.write(`[tool:${e.toolName} rewritten] ${JSON.stringify(e.input)}\n`);
        });
        emitter.on("subagent-tool", (e: { agent: string; toolName?: string; input?: unknown }) => {
            process.stderr.write(`[subagent:${e.agent}] ${e.toolName} ${JSON.stringify(e.input)}\n`);
        });
        emitter.on("subagent-finish", (e: { agent: string; usage?: UsageBlock }) => {
            process.stderr.write(
                `[subagent:${e.agent}] done${e.usage?.totalTokens ? ` (${e.usage.totalTokens} tokens)` : ""}\n`,
            );
        });
        emitter.on("hook-message", (m: string) => process.stderr.write(`\n[hook] ${m}\n`));
        emitter.on("stream-retry", (e: { attempt: number; max: number; reason: string }) =>
            process.stderr.write(`\n[retry ${e.attempt}/${e.max}] ${e.reason}\n`),
        );
        emitter.on("hook-terminal-sequence", (s: string) => process.stdout.write(s));
        emitter.on("error", (err: unknown) => process.stderr.write(`\n[error] ${String(err)}\n`));
        emitter.on("finish", () => process.stdout.write("\n"));
    }

    begin(ctx: RunContext): void {
        this.ctx = ctx;
        // On stderr, before the turn: a run that dies mid-way still tells you
        // what to pass to --session to pick it back up.
        process.stderr.write(`[session] ${ctx.sessionId}\n`);
    }

    end(result: RunResult): void {
        process.stderr.write(`\n${formatCost(result.cost)}\n`);
    }
}

/** One JSON object on stdout when the run is over. */
class JsonReporter extends BaseReporter {
    attach(emitter: TurnEmitter): void {
        this.track(emitter);
        // Hook messages are the one thing a person still wants to see live;
        // stderr is free to carry them without touching the JSON on stdout.
        emitter.on("hook-message", (m: string) => process.stderr.write(`[hook] ${m}\n`));
    }

    begin(ctx: RunContext): void {
        this.ctx = ctx;
    }

    end(result: RunResult): void {
        writeLine(this.resultObject(result));
    }
}

/** Every event as it happens, one JSON object per line. */
class StreamJsonReporter extends BaseReporter {
    attach(emitter: TurnEmitter): void {
        this.track(emitter);
        // Every event the agent loop can emit, from core's own exhaustive list:
        // a new event shows up here automatically rather than being forgotten.
        for (const name of TURN_EVENT_NAMES) {
            emitter.on(name, (payload?: unknown) => {
                writeLine(payload === undefined ? { type: name } : { type: name, data: jsonSafe(payload) });
            });
        }
    }

    begin(ctx: RunContext): void {
        this.ctx = ctx;
        writeLine({ type: "init", session_id: ctx.sessionId, model: ctx.model, cwd: ctx.cwd });
    }

    end(result: RunResult): void {
        writeLine(this.resultObject(result));
    }
}

/** The cost line the text format ends on. */
function formatCost(c: CostBreakdown): string {
    const prefix = c.estimated ? "~" : "";
    return `${prefix}$${c.usd.toFixed(4)} · in:${c.inputTokens} out:${c.outputTokens} cache:${c.cachedInputTokens}`;
}

export function createReporter(format: OutputFormat): PrintReporter {
    switch (format) {
        case "json":
            return new JsonReporter();
        case "stream-json":
            return new StreamJsonReporter();
        case "text":
            return new TextReporter();
    }
}
