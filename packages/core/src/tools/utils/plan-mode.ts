/**
 * Plan mode — a session-level read-only gate enforced at the tool layer.
 *
 * While active for a session, edit/write reject every file mutation and bash
 * runs in the fail-closed read-only sandbox, REGARDLESS of which agent or
 * permission settings are in play — the same guarantee the plan agent gets by
 * tool stripping, but flippable mid-turn (the enter_plan_mode /
 * exit_plan_mode tools) and mid-session (the TUI's agent cycle). Subagents
 * inherit the gate: their ToolContext carries the parent turn's sessionId, so
 * delegation can't widen write access while planning.
 *
 * State is process-local by design: plan mode is an interactive-session
 * concept, owned by the TUI (which clears it on implement/exit) and by the
 * enter_plan_mode / exit_plan_mode pair, each of which flips it only after
 * the user approves — the agent asks, the user decides, both ways.
 */

const activePlanSessions = new Set<string>();

export function isPlanModeActive(sessionId: string | undefined): boolean {
    return sessionId !== undefined && activePlanSessions.has(sessionId);
}

export function setPlanMode(sessionId: string, active: boolean): void {
    if (active) activePlanSessions.add(sessionId);
    else activePlanSessions.delete(sessionId);
}

/** The message edit/write hand the model while plan mode is active. */
export function formatPlanModeRefusal(): string {
    return (
        "Plan mode is active — file edits are disabled in every permission mode until the user approves a plan. " +
        "Keep investigating with the read-only tools and deliver the plan with the plan tool; " +
        "implementation starts after the user accepts it."
    );
}
