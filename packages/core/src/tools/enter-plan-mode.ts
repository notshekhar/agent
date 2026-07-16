/**
 * enter_plan_mode — agent-initiated entry into plan mode, gated on the user's
 * explicit approval (the same UI bridge as bash approval, kind "plan").
 *
 * On approval the session's plan-mode gate flips ON immediately: edit/write
 * reject and bash drops into the fail-closed read-only sandbox for the rest
 * of this turn and every following one, until the user approves a delivered
 * plan (TUI implement flow) or toggles plan mode off. Only attached for
 * unrestricted agents in interactive sessions — restricted agents (plan
 * itself, custom read-only agents) and print mode never see it.
 */
import { tool } from "ai";
import { z } from "zod";
import { getBashApprovalBridge } from "./approval-bridge";
import { isPlanModeActive, setPlanMode } from "./utils/plan-mode";

export const ENTER_PLAN_MODE_TOOL_NAME = "enter_plan_mode";

export interface EnterPlanModeContext {
    sessionId: string;
    cwd: string;
    abortSignal?: AbortSignal;
}

export function createEnterPlanModeTool(ctx: EnterPlanModeContext) {
    return tool({
        description:
            "Ask the user to switch this session into plan mode: a read-only planning phase where you explore the " +
            "codebase and design an implementation approach BEFORE writing any code. Use it only when the task has " +
            "genuine ambiguity — multiple reasonable architectures, unclear requirements, or high-impact " +
            "restructuring where the wrong approach wastes significant work. Do NOT use it for tasks with a clear " +
            "implementation path, obvious bug fixes, or changes that follow existing conventions — just do those. " +
            "Requires the user's approval; if they decline, continue in normal mode and do not ask again this turn. " +
            "While plan mode is active, file edits are rejected and bash is read-only.",
        inputSchema: z.object({
            reason: z
                .string()
                .describe(
                    "One or two sentences shown to the user: what is ambiguous about the task and what the plan will decide.",
                ),
        }),
        execute: async ({ reason }, options) => {
            if (isPlanModeActive(ctx.sessionId)) return "Plan mode is already active.";
            const bridge = getBashApprovalBridge();
            // Defensive: the tool is only attached when a bridge exists.
            if (!bridge) return "Plan mode is unavailable in this session. Continue in normal mode.";
            const signal = options?.abortSignal ?? ctx.abortSignal;
            const decision = await bridge.confirm(
                { kind: "plan", command: reason, cwd: ctx.cwd, patterns: [] },
                { signal },
            );
            if (signal?.aborted) throw new Error("Operation aborted");
            if (decision !== "once" && decision !== "always") {
                return (
                    "The user declined plan mode. Continue in normal mode — investigate as needed and proceed with " +
                    "the task directly. Do not call enter_plan_mode again for this request."
                );
            }
            setPlanMode(ctx.sessionId, true);
            return (
                "Plan mode is ON (the user approved). From now on file edits are rejected and bash is read-only — " +
                "in every permission mode. Investigate the codebase with the read-only tools and design the " +
                "implementation approach. Finish this turn by presenting your findings and the proposed approach in " +
                "chat; from the next turn the plan delivery tool is available to hand the user the final plan " +
                "document for approval. Plan mode ends when the user accepts a plan or toggles it off."
            );
        },
    });
}
