import { describe, expect, test } from "bun:test";
import {
    applyVerdict,
    decideNextAction,
    detectBail,
    firstUncheckedStep,
    GOAL_MAX_ROUNDS,
    GOAL_MAX_VERIFY_RUNS,
    GOAL_SAME_STEP_FORCE_VERIFY,
    GOAL_STALL_THRESHOLD,
    parseGoalVerdict,
    type GoalModeState,
} from "../src/agent/goal-mode";
import { buildContinuationDirective, buildGoalRulesDirective } from "../src/agent/goal-prompts";
import { CommandRegistry, registerBuiltins } from "../src/commands";

function freshState(overrides: Partial<GoalModeState> = {}): GoalModeState {
    return {
        objective: "make the tests pass",
        status: "active",
        rounds: 0,
        verifyRuns: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        planPath: "/tmp/plan.md",
        scratchDir: "/tmp/scratch",
        lastGaps: [],
        gapsFingerprint: null,
        stallStrikes: 0,
        lastNextStep: null,
        sameStepStrikes: 0,
        ...overrides,
    };
}

const PLAN = `# Plan: fix it

## Goal kind
code-change

## Acceptance criteria
1. tests pass

## Verification plan
1. run bun test

## Non-goals
- new features

## Task checklist
- [x] read the failing test
- [ ] fix the bug
- [ ] run the suite
`;

describe("firstUncheckedStep", () => {
    test("returns the first unchecked box, skipping checked ones", () => {
        expect(firstUncheckedStep(PLAN)).toBe("fix the bug");
    });

    test("supports * and + bullets", () => {
        expect(firstUncheckedStep("* [ ] alpha")).toBe("alpha");
        expect(firstUncheckedStep("+ [ ] beta")).toBe("beta");
    });

    test("null when everything is checked or no checkboxes exist", () => {
        expect(firstUncheckedStep("- [x] done\n- [X] also done")).toBeNull();
        expect(firstUncheckedStep("no boxes here")).toBeNull();
    });

    test("numbered criteria are not mined as steps", () => {
        expect(firstUncheckedStep("## Acceptance criteria\n1. tests pass")).toBeNull();
    });
});

describe("detectBail", () => {
    test("fires on hand-off phrasing at the start of the last paragraph", () => {
        expect(detectBail("Did some work.\n\nLet me know if you want me to continue.")).toBe(true);
        expect(detectBail("Progress.\n\nStopping here for now.")).toBe(true);
        expect(detectBail("Blocked.\n\nI am unable to proceed without credentials.")).toBe(true);
    });

    test("ignores mid-prose mentions and normal completions", () => {
        expect(detectBail("I fixed the bug and the tests pass.")).toBe(false);
        expect(detectBail("The function will let me know if it fails via the log line.")).toBe(false);
    });

    test("empty text is not a bail", () => {
        expect(detectBail("")).toBe(false);
    });
});

describe("decideNextAction", () => {
    test("continues with the mined next step while boxes remain", () => {
        const st = freshState();
        const action = decideNextAction(st, PLAN, "working on it");
        expect(action).toEqual({ kind: "continue", nextStep: "fix the bug", bailDetected: false });
    });

    test("verifies when the checklist is exhausted", () => {
        const st = freshState();
        expect(decideNextAction(st, "- [x] all done", "done")).toEqual({ kind: "verify" });
    });

    test("verifies when there is no plan at all", () => {
        const st = freshState();
        expect(decideNextAction(st, null, "done")).toEqual({ kind: "verify" });
    });

    test("pauses at the round cap", () => {
        const st = freshState({ rounds: GOAL_MAX_ROUNDS });
        const action = decideNextAction(st, PLAN, "still going");
        expect(action.kind).toBe("pause");
        expect((action as { reason: string }).reason).toBe("cap");
    });

    test("forces a verify after the same step repeats too many rounds", () => {
        const st = freshState();
        let last: ReturnType<typeof decideNextAction> | undefined;
        for (let i = 0; i < GOAL_SAME_STEP_FORCE_VERIFY; i++) last = decideNextAction(st, PLAN, "hm");
        expect(last).toEqual({ kind: "verify" });
        // The strike counter reset — the next round continues normally.
        expect(decideNextAction(st, PLAN, "hm").kind).toBe("continue");
    });
});

describe("parseGoalVerdict", () => {
    test("parses a fenced verdict", () => {
        const v = parseGoalVerdict(
            'Here is my verdict:\n```json\n{"refuted": true, "findings": [{"location": "a.ts:1", "detail": "no test"}], "summary": "missing tests"}\n```',
        );
        expect(v).toEqual({
            refuted: true,
            findings: [{ location: "a.ts:1", detail: "no test" }],
            summary: "missing tests",
        });
    });

    test("parses a bare object and tolerates missing fields", () => {
        const v = parseGoalVerdict('{"refuted": false}');
        expect(v).toEqual({ refuted: false, findings: [], summary: "" });
    });

    test("null on garbage", () => {
        expect(parseGoalVerdict("Not Refuted")).toBeNull();
        expect(parseGoalVerdict('{"verdict": "yes"}')).toBeNull();
    });
});

describe("applyVerdict", () => {
    test("not refuted completes the goal", () => {
        const st = freshState();
        expect(applyVerdict(st, { refuted: false, findings: [], summary: "" })).toEqual({ kind: "complete" });
        expect(st.verifyRuns).toBe(1);
    });

    test("refuted feeds gaps into a continue", () => {
        const st = freshState();
        const action = applyVerdict(st, {
            refuted: true,
            findings: [{ location: "x.ts:3", detail: "criterion 2 unmet" }],
            summary: "",
        });
        expect(action).toEqual({ kind: "continue", gaps: ["x.ts:3: criterion 2 unmet"] });
        expect(st.lastGaps).toEqual(["x.ts:3: criterion 2 unmet"]);
    });

    test("identical gaps twice in a row pause as a stall", () => {
        const st = freshState();
        const verdict = { refuted: true, findings: [{ detail: "same gap" }], summary: "" };
        for (let i = 0; i < GOAL_STALL_THRESHOLD - 1; i++) {
            expect(applyVerdict(st, verdict).kind).toBe("continue");
        }
        const action = applyVerdict(st, verdict);
        expect(action.kind).toBe("pause");
        expect((action as { reason: string }).reason).toBe("stall");
    });

    test("changed gaps reset the stall counter", () => {
        const st = freshState();
        applyVerdict(st, { refuted: true, findings: [{ detail: "gap A" }], summary: "" });
        const action = applyVerdict(st, { refuted: true, findings: [{ detail: "gap B" }], summary: "" });
        expect(action.kind).toBe("continue");
        expect(st.stallStrikes).toBe(1);
    });

    test("verify cap pauses", () => {
        const st = freshState({ verifyRuns: GOAL_MAX_VERIFY_RUNS - 1 });
        // Different gaps each round so the stall never fires first.
        const action = applyVerdict(st, { refuted: true, findings: [{ detail: "fresh gap" }], summary: "" });
        expect(action.kind).toBe("pause");
        expect((action as { reason: string }).reason).toBe("cap");
    });
});

describe("directives", () => {
    test("goal rules embed objective, plan, and scratch dir", () => {
        const text = buildGoalRulesDirective({
            objective: "ship the feature",
            planPath: "/g/plan.md",
            planText: "# Plan: ship",
            scratchDir: "/g/scratch",
        });
        expect(text).toContain("ship the feature");
        expect(text).toContain("/g/plan.md");
        expect(text).toContain("# Plan: ship");
        expect(text).toContain("/g/scratch");
        expect(text.startsWith("<system-reminder>")).toBe(true);
    });

    test("continuation carries the next step, and gaps take precedence", () => {
        const plain = buildContinuationDirective({
            objective: "obj",
            nextStep: "run the suite",
            gaps: [],
            bailDetected: false,
            rounds: 3,
            elapsedMs: 61_000,
        });
        expect(plain).toContain("run the suite");
        expect(plain).toContain("Round: 3");
        expect(plain).toContain("1m 01s");

        const withGaps = buildContinuationDirective({
            objective: "obj",
            nextStep: null,
            gaps: ["a.ts:1: no test"],
            bailDetected: false,
            rounds: 4,
            elapsedMs: 0,
        });
        expect(withGaps).toContain("REFUTED");
        expect(withGaps).toContain("a.ts:1: no test");

        const bail = buildContinuationDirective({
            objective: "obj",
            nextStep: "keep going",
            gaps: [],
            bailDetected: true,
            rounds: 1,
            elapsedMs: 0,
        });
        expect(bail).toContain("hand-off");
    });
});

describe("command registration", () => {
    test("/goal is goal mode, /background (+/bg) is the task manager, /goals is gone", async () => {
        const reg = new CommandRegistry();
        await registerBuiltins(reg, { cwd: "/nonexistent-goal-mode-test" });
        expect(reg.get("goal")?.description).toContain("Goal mode");
        expect(reg.get("background")?.description).toContain("Background tasks");
        expect(reg.get("bg")?.description).toContain("/background");
        expect(reg.has("goals")).toBe(false);
    });
});
