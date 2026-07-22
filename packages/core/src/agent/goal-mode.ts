/**
 * Goal mode — the per-session state machine behind /goal <objective>.
 *
 * Unlike background tasks (goals.ts — detached scheduled runs), goal mode
 * drives the CURRENT session: a planner writes a frozen plan once, then the
 * harness keeps the agent working turn after turn — mining the plan's first
 * unchecked checkbox into a continuation nudge — until the checklist runs
 * out, at which point an adversarial verifier audits the work. Refuted
 * verdicts feed their gaps back as the next nudge; a clean verdict completes
 * the goal. Everything here is the pure/persistence half: decisions
 * (decideNextAction / applyVerdict), checkbox mining, bail detection, and
 * verdict parsing are side-effect-free and unit-tested; the TUI owns the
 * actual resubmission loop.
 *
 * State persists as JSON under <config>/agent/goal-mode/<sessionId>/ next to
 * plan.md and the goal's scratch dir, so /resume picks a goal back up.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../brand";

/** Continuation rounds cap — a runaway-cost backstop, not the primary stop. */
export const GOAL_MAX_ROUNDS = 40;
/** Verifier runs cap per goal. */
export const GOAL_MAX_VERIFY_RUNS = 10;
/** Identical gap fingerprints in a row that auto-pause the goal (stall). */
export const GOAL_STALL_THRESHOLD = 2;
/** Same unchecked step surfacing this many rounds in a row forces a verify
 * pass — the model stopped updating its checklist, so nudging is futile. */
export const GOAL_SAME_STEP_FORCE_VERIFY = 4;
/** Cap on plan bytes read for mining/nudges — a runaway plan must not blow
 * up the context. */
export const GOAL_PLAN_READ_CAP = 32 * 1024;

export type GoalModeStatus = "active" | "verifying" | "paused" | "complete";
export type GoalPauseReason = "user" | "cap" | "stall" | "error";

export interface GoalModeState {
    objective: string;
    status: GoalModeStatus;
    pausedReason?: GoalPauseReason;
    /** Human-readable pause detail (cap hit, stall, verifier error…). */
    pauseMessage?: string;
    /** Continuation rounds fired so far. */
    rounds: number;
    verifyRuns: number;
    startedAt: number;
    updatedAt: number;
    planPath: string;
    scratchDir: string;
    /** Findings from the last refuted verdict, fed into the next nudge. */
    lastGaps: string[];
    /** Fingerprint of the last refuted verdict's findings (stall detection). */
    gapsFingerprint: string | null;
    stallStrikes: number;
    lastNextStep: string | null;
    sameStepStrikes: number;
}

export function goalModeDir(sessionId: string): string {
    return join(getConfigDir(), "agent", "goal-mode", sessionId);
}

function statePath(sessionId: string): string {
    return join(goalModeDir(sessionId), "state.json");
}

/** Create the goal's on-disk home (plan.md + scratch/) and initial state. */
export function initGoalState(sessionId: string, objective: string): GoalModeState {
    const dir = goalModeDir(sessionId);
    const scratchDir = join(dir, "scratch");
    mkdirSync(scratchDir, { recursive: true });
    const now = Date.now();
    const state: GoalModeState = {
        objective,
        status: "active",
        rounds: 0,
        verifyRuns: 0,
        startedAt: now,
        updatedAt: now,
        planPath: join(dir, "plan.md"),
        scratchDir,
        lastGaps: [],
        gapsFingerprint: null,
        stallStrikes: 0,
        lastNextStep: null,
        sameStepStrikes: 0,
    };
    saveGoalState(sessionId, state);
    return state;
}

export function loadGoalState(sessionId: string): GoalModeState | null {
    try {
        const raw = readFileSync(statePath(sessionId), "utf8");
        const parsed = JSON.parse(raw) as GoalModeState;
        if (typeof parsed.objective !== "string" || typeof parsed.status !== "string") return null;
        return parsed;
    } catch {
        return null;
    }
}

export function saveGoalState(sessionId: string, state: GoalModeState): void {
    state.updatedAt = Date.now();
    mkdirSync(goalModeDir(sessionId), { recursive: true });
    writeFileSync(statePath(sessionId), JSON.stringify(state, null, 2));
}

/** Remove the goal's state file and scratch; plan.md goes with the dir. */
export function clearGoalState(sessionId: string): void {
    try {
        rmSync(goalModeDir(sessionId), { recursive: true, force: true });
    } catch {}
}

export function writeGoalPlan(state: GoalModeState, planText: string): void {
    writeFileSync(state.planPath, planText);
}

/** Read plan.md, capped; null on any failure. When the cap is hit the
 * trailing possibly-incomplete line is dropped so a half-truncated bullet
 * never leaks into a nudge. */
export function readGoalPlan(state: GoalModeState): string | null {
    try {
        if (!existsSync(state.planPath)) return null;
        let text = readFileSync(state.planPath, "utf8");
        if (text.length > GOAL_PLAN_READ_CAP) {
            text = text.slice(0, GOAL_PLAN_READ_CAP);
            const lastNl = text.lastIndexOf("\n");
            if (lastNl > 0) text = text.slice(0, lastNl);
        }
        return text;
    } catch {
        return null;
    }
}

/** First unchecked `- [ ]` (or `* [ ]` / `+ [ ]`) markdown checkbox;
 * `- [x]`/`- [X]` are skipped. Null when none remain. */
export function firstUncheckedStep(planText: string): string | null {
    for (const line of planText.split("\n")) {
        const m = /^\s*[-*+]\s+\[ \]\s+(.+\S)\s*$/.exec(line);
        if (m) return m[1];
    }
    return null;
}

/** Bail/hand-off phrases that mean the model stopped without finishing.
 * Matched against the START of the last non-empty paragraph's first line —
 * mid-prose mentions are intentionally ignored. */
const BAIL_PATTERNS: RegExp[] = [
    /^(?:i\s*(?:am|'m)\s+)?unable to (?:proceed|continue)/i,
    /^(?:i\s+)?(?:give|giving) up/i,
    /^(?:stopping|pausing|paused|parking|parked) (?:here|this|the)/i,
    /^let me know (?:if|when|how|whether|what)/i,
    /^(?:i(?:'ll| will) )?(?:wait|check back|circle back)/i,
    /^(?:once|when|as soon as) you(?:'ve|'re| have| are| review| approve| confirm)/i,
    /^(?:please )?(?:review|confirm|approve) (?:and|the|this|these|when)/i,
];

/** True when the turn-final text ends on a bail/hand-off paragraph. */
export function detectBail(finalText: string): boolean {
    const paragraphs = finalText
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);
    const last = paragraphs[paragraphs.length - 1];
    if (!last) return false;
    const firstLine = (last.split("\n")[0] ?? "").trim();
    return BAIL_PATTERNS.some((re) => re.test(firstLine));
}

export type GoalNextAction =
    | { kind: "continue"; nextStep: string | null; bailDetected: boolean }
    | { kind: "verify" }
    | { kind: "pause"; reason: GoalPauseReason; message: string };

/**
 * Decide what happens after an implementer turn ends. Mutates the strike
 * counters on `state` (caller saves). Unchecked checklist boxes → continue
 * with the mined step; checklist exhausted (or the same box stuck for
 * GOAL_SAME_STEP_FORCE_VERIFY rounds) → verify; round cap → pause.
 */
export function decideNextAction(state: GoalModeState, planText: string | null, finalText: string): GoalNextAction {
    if (state.rounds >= GOAL_MAX_ROUNDS) {
        return {
            kind: "pause",
            reason: "cap",
            message: `round cap reached (${GOAL_MAX_ROUNDS}) — resume with /goal resume if the work should go on`,
        };
    }
    const nextStep = planText ? firstUncheckedStep(planText) : null;
    if (nextStep === null) return { kind: "verify" };
    if (nextStep === state.lastNextStep) {
        state.sameStepStrikes += 1;
        if (state.sameStepStrikes >= GOAL_SAME_STEP_FORCE_VERIFY) {
            state.sameStepStrikes = 0;
            return { kind: "verify" };
        }
    } else {
        state.lastNextStep = nextStep;
        state.sameStepStrikes = 1;
    }
    return { kind: "continue", nextStep, bailDetected: detectBail(finalText) };
}

export interface GoalVerdict {
    refuted: boolean;
    findings: { location?: string; detail: string }[];
    summary: string;
}

/** Parse the verifier's JSON verdict out of its final response. Accepts a
 * ```json fence or a bare object; null when nothing parseable is found. */
export function parseGoalVerdict(text: string): GoalVerdict | null {
    const candidates: string[] = [];
    for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)) candidates.push(m[1]);
    const brace = text.indexOf("{");
    if (brace >= 0) candidates.push(text.slice(brace, text.lastIndexOf("}") + 1));
    for (const c of candidates.reverse()) {
        try {
            const obj = JSON.parse(c) as Partial<GoalVerdict>;
            if (typeof obj.refuted !== "boolean") continue;
            const findings = Array.isArray(obj.findings)
                ? obj.findings
                      .map((f) => ({
                          location: typeof f?.location === "string" ? f.location : undefined,
                          detail: typeof f?.detail === "string" ? f.detail : String(f?.detail ?? ""),
                      }))
                      .filter((f) => f.detail)
                : [];
            return { refuted: obj.refuted, findings, summary: typeof obj.summary === "string" ? obj.summary : "" };
        } catch {}
    }
    return null;
}

export type GoalVerdictAction =
    | { kind: "complete" }
    | { kind: "continue"; gaps: string[] }
    | { kind: "pause"; reason: GoalPauseReason; message: string };

/** One finding rendered for the nudge / stall fingerprint. */
function findingLine(f: { location?: string; detail: string }): string {
    return f.location ? `${f.location}: ${f.detail}` : f.detail;
}

/**
 * Fold a verifier verdict into the state. Mutates counters on `state`
 * (caller saves). Not refuted → complete. Refuted → continue with the gaps,
 * unless the same gaps repeat (stall) or the verify cap is hit (pause).
 */
export function applyVerdict(state: GoalModeState, verdict: GoalVerdict): GoalVerdictAction {
    state.verifyRuns += 1;
    if (!verdict.refuted) return { kind: "complete" };
    const gaps = verdict.findings.length
        ? verdict.findings.map(findingLine)
        : [verdict.summary || "verifier refuted completion without findings"];
    const fingerprint = [...gaps].sort().join("\n");
    if (fingerprint === state.gapsFingerprint) {
        state.stallStrikes += 1;
    } else {
        state.gapsFingerprint = fingerprint;
        state.stallStrikes = 1;
    }
    state.lastGaps = gaps;
    if (state.stallStrikes >= GOAL_STALL_THRESHOLD) {
        return {
            kind: "pause",
            reason: "stall",
            message:
                "verifier flagged the same gaps twice with no progress — inspect, then /goal resume or /goal clear",
        };
    }
    if (state.verifyRuns >= GOAL_MAX_VERIFY_RUNS) {
        return {
            kind: "pause",
            reason: "cap",
            message: `verification cap reached (${GOAL_MAX_VERIFY_RUNS} runs) — inspect, then /goal resume or /goal clear`,
        };
    }
    return { kind: "continue", gaps };
}
