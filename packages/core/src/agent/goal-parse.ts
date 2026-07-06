/**
 * Natural-language /goal parsing: one small generateObject call turns
 * "check the deps every day at 9am with the reviewer agent" into a clean
 * objective + schedule + agent. Same side-channel-model-call pattern as
 * recap.ts. Callers own validation (cron via croner, agent existence) and
 * MUST fall back to a plain standing goal on any failure — parsing is a
 * convenience, never a gate.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../providers";
import type { GoalSchedule } from "../goals";
import type { CostTracker } from "./cost";

const goalParseSchema = z.object({
    text: z
        .string()
        .describe("The objective itself, with schedule words and agent mentions stripped. Imperative, concise."),
    kind: z
        .enum(["none", "once", "cron"])
        .describe("none = no time expression (standing goal); once = a single future moment; cron = recurring."),
    // nullish, not nullable: models routinely omit irrelevant fields rather
    // than emitting explicit nulls, and either must validate.
    onceInMinutes: z
        .number()
        .nullish()
        .describe(
            'For kind "once" with a RELATIVE delay ("in 10 minutes", "after 2 hours"): the delay in minutes from now. Preferred over onceAtIso — never do clock arithmetic yourself. Otherwise null.',
        ),
    onceAtIso: z
        .string()
        .nullish()
        .describe(
            'For kind "once" with an ABSOLUTE time ("at 18:30", "tomorrow 9am"): the local datetime as "YYYY-MM-DDTHH:mm" (no timezone suffix). Null when onceInMinutes is set.',
        ),
    cronExpr: z
        .string()
        .nullish()
        .describe('For kind "cron": a standard 5-field cron expression (minute hour day month weekday). Otherwise null.'),
    agent: z
        .string()
        .nullish()
        .describe("An agent name ONLY if the user explicitly names one of the available agents. Otherwise null."),
});

export type ParsedGoal = z.infer<typeof goalParseSchema>;

function buildInstructions(agentNames: string[], now: Date): string {
    return `You parse a user's goal command for a coding agent into a structured goal.

Current local datetime: ${now.toString()}

Available agents: ${agentNames.join(", ")}

Output a single flat JSON object with EXACTLY these keys: "text", "kind", "onceInMinutes", "onceAtIso", "cronExpr", "agent". Never nest, rename, or add keys.

Rules:
- "text" is the objective with all schedule phrases and agent mentions removed. Keep the user's wording otherwise.
- No time expression at all → kind "none".
- A RELATIVE delay ("in 10 minutes", "after 2 hours") → kind "once" with onceInMinutes = the delay in minutes. Do NOT compute a datetime yourself.
- An ABSOLUTE moment ("tomorrow at 6pm", "at 18:30") → kind "once" with onceAtIso in the FUTURE relative to the current datetime above.
- Recurring ("every day at 9", "each monday", "hourly", "every weekday morning") → kind "cron" with a 5-field expression. "morning" = 09:00, "evening" = 18:00 unless stated.
- Set "agent" only when the user clearly names one of the available agents ("with the reviewer agent", "use plan"). Never guess; a task description that merely resembles an agent's job is NOT a mention.

Examples (input → output):
"check the deps every day at 9am"
{"text": "check the deps", "kind": "cron", "onceInMinutes": null, "onceAtIso": null, "cronExpr": "0 9 * * *", "agent": null}
"remind me to rebase in 45 minutes"
{"text": "rebase", "kind": "once", "onceInMinutes": 45, "onceAtIso": null, "cronExpr": null, "agent": null}
"say hi after 1 min"
{"text": "say hi", "kind": "once", "onceInMinutes": 1, "onceAtIso": null, "cronExpr": null, "agent": null}
"deploy tomorrow at 09:30" (assuming today = 2026-01-05)
{"text": "deploy", "kind": "once", "onceInMinutes": null, "onceAtIso": "2026-01-06T09:30", "cronExpr": null, "agent": null}
"keep the README under 100 lines"
{"text": "keep the README under 100 lines", "kind": "none", "onceInMinutes": null, "onceAtIso": null, "cronExpr": null, "agent": null}
"run the tests each friday at 17:00 with the reviewer agent" (reviewer being an available agent)
{"text": "run the tests", "kind": "cron", "onceInMinutes": null, "onceAtIso": null, "cronExpr": "0 17 * * 5", "agent": "reviewer"}`;
}

/**
 * Map the model's output to a persistable schedule. Pure — unit-tested
 * without a model. Returns null when the parse is unusable (caller falls
 * back to a standing goal). A once-time up to 24h in the past is assumed to
 * mean "next occurrence" and rolls forward a day (same trick as the manual
 * "18:30" input); older than that is a hallucination and rejected.
 */
export function toGoalSchedule(parsed: ParsedGoal, now: number): GoalSchedule | null {
    if (parsed.kind === "none") return { kind: "none" };
    if (parsed.kind === "once") {
        // Relative delays win: the model extracts "45" from "in 45 minutes"
        // reliably, but adding 45 minutes to a wall clock it cannot.
        if (typeof parsed.onceInMinutes === "number" && Number.isFinite(parsed.onceInMinutes) && parsed.onceInMinutes > 0) {
            return { kind: "once", at: now + Math.round(parsed.onceInMinutes * 60_000) };
        }
        if (!parsed.onceAtIso) return null;
        const at = new Date(parsed.onceAtIso).getTime();
        if (Number.isNaN(at)) return null;
        if (at > now) return { kind: "once", at };
        if (now - at <= 24 * 60 * 60 * 1000) return { kind: "once", at: at + 24 * 60 * 60 * 1000 };
        return null;
    }
    if (!parsed.cronExpr?.trim()) return null;
    return { kind: "cron", expr: parsed.cronExpr.trim() };
}

export async function parseGoalInput(opts: {
    raw: string;
    modelId: string;
    agentNames: string[];
    tracker?: CostTracker;
    cwd?: string;
    sessionPub?: string;
    abortSignal?: AbortSignal;
}): Promise<ParsedGoal> {
    const model = await getModel(opts.modelId);
    const result = await generateObject({
        model,
        schema: goalParseSchema,
        instructions: buildInstructions(opts.agentNames, new Date()),
        prompt: opts.raw,
        abortSignal: opts.abortSignal,
        // Providers without native JSON mode wrap the object in ```json fences
        // — strip them instead of failing the parse.
        experimental_repairText: async ({ text }) => {
            const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
            return fenced?.[1] ?? text;
        },
    });
    if (opts.tracker && result.usage) {
        opts.tracker.add(opts.modelId, result.usage, {
            cwd: opts.cwd,
            sessionPub: opts.sessionPub,
            source: "goal-parse",
        });
    }
    return result.object;
}
