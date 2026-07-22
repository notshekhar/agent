/**
 * Goal mode engine — /goal <objective> drives the CURRENT session
 * autonomously until an adversarial verifier agrees the objective is met.
 *
 * Flow: a detached planner role writes a frozen plan (fail-closed — no plan,
 * no goal), the objective is submitted as the first turn with the goal rules
 * injected, and after every turn the engine decides what happens next
 * (core's decideNextAction): unchecked plan checkboxes → a continuation
 * directive resubmitted through the normal onSubmit pipeline; checklist
 * exhausted → a detached read-only verifier role audits the workspace.
 * Refuted verdicts feed their gaps into the next continuation; a clean
 * verdict completes the goal. Esc pauses (resume with /goal resume); caps
 * and stalls auto-pause instead of burning tokens forever.
 */
import chalk from "chalk";
import {
    applyVerdict,
    buildContinuationDirective,
    buildGoalRulesDirective,
    buildPlannerPrompt,
    buildVerifierPrompt,
    clearGoalState,
    decideNextAction,
    firstUncheckedStep,
    formatGoalElapsed,
    GOAL_PLANNER_SYSTEM,
    GOAL_VERIFIER_SYSTEM,
    initGoalState,
    loadGoalState,
    parseGoalVerdict,
    readGoalPlan,
    runGoalRole,
    saveGoalState,
    writeGoalPlan,
    type GoalModeState,
    type GoalPauseReason,
} from "@notshekhar/loop-core";
import { notify } from "../notify";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";

/** The visible user row each auto-continued round submits (the directive
 * itself rides pendingInjection and renders collapsed). */
const CONTINUE_TEXT = "Continue working toward the goal.";

export interface GoalModeEngine {
    manageGoalMode(args: string): Promise<void>;
    /** Turn-runner calls this from its finally for every finished turn. */
    afterTurn(finalText: string, aborted: boolean): void;
}

// Keyed on AppState so parallel apps in tests never share an engine.
const engines = new WeakMap<AppState, GoalModeEngine>();

export function goalModeEngine(state: AppState, deps: AppDeps): GoalModeEngine {
    let engine = engines.get(state);
    if (!engine) {
        engine = createEngine(state, deps);
        engines.set(state, engine);
    }
    return engine;
}

function createEngine(state: AppState, deps: AppDeps): GoalModeEngine {
    const { tui, history, showWorking, hideWorking, ensureSession, tracker } = deps;

    const say = (text: string) => {
        history.addSystem(text);
        tui.requestRender();
    };

    const pause = (sessionId: string, st: GoalModeState, reason: GoalPauseReason, message: string) => {
        st.status = "paused";
        st.pausedReason = reason;
        st.pauseMessage = message;
        saveGoalState(sessionId, st);
        const color = reason === "user" ? chalk.dim : chalk.yellow;
        say(color(`goal paused — ${message}`));
    };

    /** Bump the round counter and resubmit through the normal turn pipeline.
     * The directive rides pendingInjection so the TUI collapses it. */
    const submitContinuation = (sessionId: string, st: GoalModeState, directive: string) => {
        st.rounds += 1;
        st.status = "active";
        saveGoalState(sessionId, st);
        state.pendingInjection = directive;
        void deps.editor.onSubmit?.(CONTINUE_TEXT);
    };

    const continueWith = (
        sessionId: string,
        st: GoalModeState,
        opts: { nextStep: string | null; gaps: string[]; bailDetected: boolean },
    ) => {
        const directive = buildContinuationDirective({
            objective: st.objective,
            nextStep: opts.nextStep,
            gaps: opts.gaps,
            bailDetected: opts.bailDetected,
            rounds: st.rounds + 1,
            elapsedMs: Date.now() - st.startedAt,
        });
        submitContinuation(sessionId, st, directive);
    };

    async function runVerification(sessionId: string, st: GoalModeState, finalText: string): Promise<void> {
        say(chalk.dim(`goal checklist done — verifying (run ${st.verifyRuns + 1})`));
        if (!state.busy) showWorking("Verifying goal");
        try {
            const { text } = await runGoalRole({
                role: "goal-verifier",
                system: GOAL_VERIFIER_SYSTEM,
                prompt: buildVerifierPrompt({
                    objective: st.objective,
                    planText: readGoalPlan(st),
                    finalResponse: finalText,
                    priorGaps: st.lastGaps,
                    cwd: state.cwd,
                }),
                modelId: state.modelId,
                cwd: state.cwd,
                sessionId,
                tracker,
                abortSignal: state.abort.signal,
            });
            const verdict = parseGoalVerdict(text);
            if (!verdict) {
                pause(sessionId, st, "error", "verifier returned no parseable verdict — /goal resume to retry");
                return;
            }
            const action = applyVerdict(st, verdict);
            if (action.kind === "complete") {
                st.status = "complete";
                saveGoalState(sessionId, st);
                const took = `${st.rounds} round${st.rounds === 1 ? "" : "s"} · ${formatGoalElapsed(Date.now() - st.startedAt)}`;
                say(
                    chalk.green(`goal complete — ${st.objective}`) +
                        chalk.dim(`  ·  ${took}${verdict.summary ? `  ·  ${verdict.summary}` : ""}`),
                );
                notify("goal complete", st.objective);
                return;
            }
            if (action.kind === "pause") {
                pause(sessionId, st, action.reason, action.message);
                notify("goal paused", st.objective);
                return;
            }
            say(
                chalk.yellow(`verification refuted — ${action.gaps.length} gap${action.gaps.length === 1 ? "" : "s"}`) +
                    chalk.dim(" · continuing"),
            );
            continueWith(sessionId, st, { nextStep: null, gaps: action.gaps, bailDetected: false });
        } catch (err) {
            if (state.abort.signal.aborted) {
                pause(sessionId, st, "user", "interrupted during verification — /goal resume to continue");
            } else {
                pause(sessionId, st, "error", `verifier failed: ${(err as Error).message} — /goal resume to retry`);
            }
        } finally {
            if (!state.busy) hideWorking();
            tui.requestRender();
        }
    }

    function afterTurn(finalText: string, aborted: boolean): void {
        const sessionId = state.session?.id;
        if (!sessionId) return;
        const st = loadGoalState(sessionId);
        if (!st || st.status !== "active") return;
        if (aborted) {
            pause(sessionId, st, "user", "interrupted — /goal resume to continue, /goal clear to drop it");
            return;
        }
        // User interjections queued during the turn run first; the goal
        // re-evaluates after each of their turns ends (adoption semantics).
        if (deps.queuedMessages.length > 0) return;
        const planText = readGoalPlan(st);
        const action = decideNextAction(st, planText, finalText);
        if (action.kind === "pause") {
            pause(sessionId, st, action.reason, action.message);
            notify("goal paused", st.objective);
            return;
        }
        if (action.kind === "continue") {
            continueWith(sessionId, st, {
                nextStep: action.nextStep,
                gaps: [],
                bailDetected: action.bailDetected,
            });
            return;
        }
        st.status = "verifying";
        saveGoalState(sessionId, st);
        void runVerification(sessionId, st, finalText);
    }

    async function start(objective: string): Promise<void> {
        if (!state.modelId) {
            say("No model selected. Run /provider to pick one, or /login to add a provider.");
            return;
        }
        const session = await ensureSession();
        const existing = loadGoalState(session.id);
        if (existing && existing.status !== "complete") {
            say(
                chalk.yellow(`a goal is already ${existing.status} in this session — `) +
                    chalk.dim("/goal status · /goal resume · /goal clear"),
            );
            return;
        }
        showWorking("Planning goal");
        tui.requestRender();
        let planText = "";
        try {
            const { text } = await runGoalRole({
                role: "goal-planner",
                system: GOAL_PLANNER_SYSTEM,
                prompt: buildPlannerPrompt(objective, state.cwd),
                modelId: state.modelId,
                cwd: state.cwd,
                sessionId: session.id,
                tracker,
                abortSignal: state.abort.signal,
            });
            planText = text;
        } catch (err) {
            // Fail-closed like grok's planner: no plan, no goal.
            say(chalk.red(`goal planning failed — ${(err as Error).message}. Goal not started.`));
            return;
        } finally {
            hideWorking();
            tui.requestRender();
        }
        if (!planText.includes("## Acceptance criteria") || !planText.includes("- [ ]")) {
            say(chalk.red("goal planning failed — the planner produced no usable plan. Goal not started."));
            return;
        }
        const st = initGoalState(session.id, objective);
        writeGoalPlan(st, planText);
        say(chalk.dim(`goal set — plan at ${st.planPath}`));
        state.pendingInjection = buildGoalRulesDirective({
            objective,
            planPath: st.planPath,
            planText,
            scratchDir: st.scratchDir,
        });
        void deps.editor.onSubmit?.(objective);
    }

    function status(): void {
        const sessionId = state.session?.id;
        const st = sessionId ? loadGoalState(sessionId) : null;
        if (!st) {
            say(chalk.dim("no goal in this session — start one with /goal <objective>"));
            return;
        }
        const lines = [
            `goal: ${st.objective}`,
            `status: ${st.status}${st.pausedReason ? ` (${st.pausedReason})` : ""}${st.pauseMessage ? ` — ${st.pauseMessage}` : ""}`,
            `rounds: ${st.rounds}  ·  verifications: ${st.verifyRuns}  ·  elapsed: ${formatGoalElapsed(Date.now() - st.startedAt)}`,
            `plan: ${st.planPath}`,
        ];
        if (st.lastGaps.length) {
            lines.push("last gaps:");
            for (const g of st.lastGaps.slice(0, 5)) lines.push(`  - ${g}`);
        }
        say(lines.join("\n"));
    }

    function resume(): void {
        const sessionId = state.session?.id;
        const st = sessionId ? loadGoalState(sessionId) : null;
        if (!st || !sessionId) {
            say(chalk.dim("no goal to resume — start one with /goal <objective>"));
            return;
        }
        if (st.status === "complete") {
            say(chalk.dim("goal already complete — start a new one with /goal <objective>"));
            return;
        }
        if (st.status === "active" || st.status === "verifying") {
            say(chalk.dim(`goal is already ${st.status}`));
            return;
        }
        st.pausedReason = undefined;
        st.pauseMessage = undefined;
        // A pause consumed a stall/cap strike decision — resuming grants a
        // fresh look rather than instantly re-pausing on the same counters.
        st.stallStrikes = 0;
        st.sameStepStrikes = 0;
        const planText = readGoalPlan(st);
        const nextStep = planText ? firstUncheckedStep(planText) : null;
        say(chalk.dim("goal resumed"));
        continueWith(sessionId, st, { nextStep, gaps: st.lastGaps, bailDetected: false });
    }

    async function manageGoalMode(args: string): Promise<void> {
        const text = args.trim();
        const sub = text.toLowerCase();
        if (!text || sub === "status") return status();
        if (sub === "pause") {
            const sessionId = state.session?.id;
            const st = sessionId ? loadGoalState(sessionId) : null;
            if (!st || !sessionId || (st.status !== "active" && st.status !== "verifying")) {
                say(chalk.dim("no active goal to pause"));
                return;
            }
            pause(sessionId, st, "user", "paused — /goal resume to continue");
            return;
        }
        if (sub === "resume" || sub === "continue") return resume();
        if (sub === "clear" || sub === "stop" || sub === "cancel") {
            const sessionId = state.session?.id;
            if (sessionId && loadGoalState(sessionId)) {
                clearGoalState(sessionId);
                say(chalk.dim("goal cleared"));
            } else {
                say(chalk.dim("no goal to clear"));
            }
            return;
        }
        await start(text);
    }

    return { manageGoalMode, afterTurn };
}
