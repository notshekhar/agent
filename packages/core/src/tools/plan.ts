/**
 * plan — the plan agent's delivery tool. Calling it ends the turn (runTurn
 * adds a hasToolCall("plan") stop condition when the tool is present), so the
 * final plan arrives as a structured tool input instead of trailing prose.
 * The TUI picks the plan out of the tool call and offers implement / discuss;
 * in print mode it simply lands in the transcript.
 */
import { tool } from "ai";
import { z } from "zod";

export const PLAN_TOOL_NAME = "plan";

/** A real plan is a document, not a headline. Deliveries shorter than this
 * are rejected so the model retries with the full text — some models
 * habitually send just a title on the first call. */
export const PLAN_MIN_CHARS = 200;

/** True when this tool input is an accepted (non-stub) plan delivery. Shared
 * by the turn's stop condition and the TUI's follow-up flow so both agree on
 * what counts as delivered. */
export function isDeliveredPlan(input: unknown): boolean {
    const plan = (input as { plan?: unknown } | undefined)?.plan;
    return typeof plan === "string" && plan.trim().length >= PLAN_MIN_CHARS;
}

/**
 * Repair a plan that arrived single-line with literal \n escapes — some
 * models double-escape the JSON string. Only fires on the unambiguous case
 * (essentially no real newlines but several literal ones); a genuinely
 * multi-line plan that mentions "\n" in a code snippet is left alone.
 */
export function normalizePlanText(plan: string): string {
    const realNewlines = (plan.match(/\n/g) ?? []).length;
    const literalNewlines = (plan.match(/\\n/g) ?? []).length;
    if (realNewlines <= 1 && literalNewlines >= 3) {
        return plan.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
    }
    return plan;
}

/** Minimal structural slice of the AI SDK's StepResult that the stop
 * condition needs — keeps this module free of the SDK's generics. */
interface StepToolCalls {
    toolCalls?: Array<{ toolName: string; input?: unknown }>;
}

/**
 * streamText stop condition for plan-capable turns: stop once the last step
 * contains a substantial plan delivery. Stub deliveries (title-only) are
 * rejected by execute above and deliberately do NOT stop the turn — the model
 * must read the rejection and deliver the real document.
 */
export function planDeliveredThisStep({ steps }: { steps: StepToolCalls[] }): boolean {
    const calls = steps.at(-1)?.toolCalls;
    return calls?.some((c) => c.toolName === PLAN_TOOL_NAME && isDeliveredPlan(c.input)) ?? false;
}

export function createPlanTool() {
    return tool({
        description:
            "Write the final plan document into this tool. Treat the `plan` argument exactly like the write tool's " +
            "`content`: the complete markdown document goes in the argument, top to bottom, with real line breaks " +
            "(never literal \\n escape sequences). It is the ONLY thing the user receives — chat text is not part of " +
            "the plan.\n\n" +
            "The document must have this shape (typically 30-150 lines):\n\n" +
            "# <title>\n\n## Context\n<the problem and why this approach>\n\n## Steps\n1. <file — exact change, " +
            "anchors: function names, patterns to mirror>\n2. <…in execution order>\n\n## Verification\n<how to " +
            "prove it works>\n\n## Risks\n<open questions, decisions left to the user>\n\n" +
            "A call containing only a title or summary is rejected and you will be told to call again. " +
            "Call it once, when the plan is final — a successful delivery ends your turn.",
        inputSchema: z.object({
            plan: z
                .string()
                .min(PLAN_MIN_CHARS)
                .describe(
                    "The complete plan document as markdown — like a file body: title, context, ordered steps with exact " +
                        "files and anchors, verification, risks. Minimum 200 characters; a title or summary is rejected. " +
                        "Self-contained: an agent that has seen none of this conversation must be able to execute it.",
                ),
        }),
        execute: async ({ plan }) => {
            // Rejecting here (instead of erroring) keeps the loop alive: the
            // model reads this result and calls again with the full document.
            // The turn's stop condition ignores rejected (stub) deliveries.
            if (plan.trim().length < PLAN_MIN_CHARS) {
                return (
                    "REJECTED: that was only a title/summary, not the plan. Call plan again with the COMPLETE plan " +
                    "document in the `plan` argument — every section and step as markdown. Do not write the plan as " +
                    "chat text; only the `plan` argument reaches the user."
                );
            }
            return "Plan delivered to the user.";
        },
    });
}
