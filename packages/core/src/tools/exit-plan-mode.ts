/**
 * exit_plan_mode — agent-initiated EXIT from plan mode, the mirror of
 * enter_plan_mode and gated on the same user approval bridge (kind
 * "exit-plan").
 *
 * Why it exists: plan mode used to be a one-way door for the agent. It could
 * flip the gate on itself (enter_plan_mode) but only the human could lift it
 * — via the plan tool's implement/talk follow-up, which ENDS the turn and
 * hands the plan to a fresh agent. That loses the whole investigation the
 * planning agent just did. This tool closes the loop: the agent presents the
 * finished plan, the user approves, the gate lifts mid-turn and the SAME
 * agent implements it immediately, with all of its context intact.
 *
 * Only attached for unrestricted agents in interactive sessions while plan
 * mode is active. Restricted agents (the plan builtin, custom read-only
 * agents) keep the plan tool + handoff flow: lifting the gate buys them
 * nothing since they have no edit/write tools to begin with.
 */
import { tool } from "ai";
import { z } from "zod";
import { getBashApprovalBridge } from "./approval-bridge";
import { PLAN_MIN_CHARS } from "./plan";
import { isPlanModeActive, setPlanMode } from "./utils/plan-mode";

export const EXIT_PLAN_MODE_TOOL_NAME = "exit_plan_mode";

export interface ExitPlanModeContext {
    sessionId: string;
    cwd: string;
    abortSignal?: AbortSignal;
}

/** The plan's first heading — what the approval prompt shows as its headline
 * (the full document is already on screen in the tool's box). */
export function planHeadline(plan: string): string {
    const first = (plan.split("\n").find((l) => l.trim().length > 0) ?? "").replace(/^#+\s*/, "").trim();
    return first.length > 100 ? `${first.slice(0, 97)}…` : first;
}

export function createExitPlanModeTool(ctx: ExitPlanModeContext) {
    return tool({
        description:
            "Present your finished implementation plan and ask the user to leave plan mode so you can build it. " +
            "Call this ONLY when the planning work is done: you have investigated the codebase and the plan is " +
            "complete enough for someone else to execute. Write the whole plan document into the `plan` argument " +
            "exactly like the write tool's `content` — it is the only thing the user sees when deciding.\n\n" +
            "The document must have this shape (typically 30-150 lines):\n\n" +
            "# <title>\n\n## Context\n<the problem and why this approach>\n\n## Steps\n1. <file — exact change, " +
            "anchors: function names, patterns to mirror>\n2. <…in execution order>\n\n## Verification\n<how to " +
            "prove it works>\n\n## Risks\n<open questions, decisions left to the user>\n\n" +
            "If the user approves, plan mode ends immediately and you continue in the SAME turn — start " +
            "implementing the plan you just delivered, do not wait for another message. If they decline, plan " +
            "mode stays on: keep refining and call again once the plan answers their objection. " +
            "Do not call it to ask a question — use it only to deliver a plan.",
        inputSchema: z.object({
            plan: z
                .string()
                .min(PLAN_MIN_CHARS)
                .describe(
                    "The complete plan document as markdown — like a file body: title, context, ordered steps with exact " +
                        "files and anchors, verification, risks. Minimum 200 characters; a title or summary is rejected.",
                ),
        }),
        execute: async ({ plan }, options) => {
            if (!isPlanModeActive(ctx.sessionId)) {
                return "Plan mode is not active — nothing to exit. Continue with the task directly.";
            }
            // Rejecting (instead of erroring) keeps the loop alive: the model
            // reads this result and calls again with the full document.
            if (plan.trim().length < PLAN_MIN_CHARS) {
                return (
                    "REJECTED: that was only a title/summary, not the plan. Call exit_plan_mode again with the " +
                    "COMPLETE plan document in the `plan` argument — every section and step as markdown. Do not " +
                    "write the plan as chat text; only the `plan` argument reaches the user."
                );
            }
            const bridge = getBashApprovalBridge();
            // Defensive: the tool is only attached when a bridge exists.
            if (!bridge) {
                return (
                    "Plan mode can only be lifted by the user in this session. Present the plan in chat and stop; " +
                    "do not attempt file edits."
                );
            }
            const signal = options?.abortSignal ?? ctx.abortSignal;
            const decision = await bridge.confirm(
                { kind: "exit-plan", command: planHeadline(plan), cwd: ctx.cwd, patterns: [] },
                { signal },
            );
            if (signal?.aborted) throw new Error("Operation aborted");
            if (decision !== "once" && decision !== "always") {
                return (
                    "The user did not approve the plan. Plan mode stays ON — edits are still rejected and bash is " +
                    "still read-only. Ask what they want changed or keep investigating, then call exit_plan_mode " +
                    "again with the revised plan. Do not attempt file edits in the meantime."
                );
            }
            setPlanMode(ctx.sessionId, false);
            return (
                "Approved — plan mode is OFF. File edits and writable bash are enabled again. Implement the plan " +
                "you just delivered now, in this same turn: work through its steps in order, then run the " +
                "verification it describes. Do not re-plan and do not wait for another message."
            );
        },
    });
}
