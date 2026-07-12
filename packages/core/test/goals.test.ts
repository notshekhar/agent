import { afterEach, describe, expect, test } from "bun:test";
import { setDbPathForTests } from "../src/sessions/db";
import {
    addGoal,
    deleteGoal,
    GoalLimitError,
    isGoalDue,
    listGoals,
    MAX_GOALS,
    recordGoalRunEnd,
    recordGoalRunStart,
    STALE_RUN_MS,
    updateGoal,
    type Goal,
} from "../src/goals";

afterEach(() => setDbPathForTests(null));

describe("goals CRUD", () => {
    test("add/list/update/delete roundtrip across all schedule kinds", () => {
        setDbPathForTests(":memory:");
        const standing = addGoal("ship v1", "/repo", { kind: "none" });
        const once = addGoal(
            "check CI",
            "/repo",
            { kind: "once", at: 123 },
            { model: "prov/model", agent: "reviewer" },
        );
        const cron = addGoal("update deps", "/other", { kind: "cron", expr: "0 9 * * *" });

        const all = listGoals();
        expect(all.map((g) => g.id)).toEqual([standing.id, once.id, cron.id]);
        expect(listGoals("/repo").map((g) => g.text)).toEqual(["ship v1", "check CI"]);
        expect(all[1]?.model).toBe("prov/model");
        expect(all[1]?.agent).toBe("reviewer");
        expect(all[0]?.agent).toBeUndefined();
        expect(all[2]).toMatchObject({ kind: "cron", expr: "0 9 * * *", enabled: true });

        // Agent is patchable and clearable.
        expect(updateGoal(standing.id, { agent: "helper" })?.agent).toBe("helper");
        expect(updateGoal(standing.id, { agent: null })?.agent).toBeUndefined();
        // Unrelated patches leave it untouched.
        expect(updateGoal(once.id, { text: "check CI twice" })?.agent).toBe("reviewer");

        // Schedule replaced wholesale: cron → once leaves no stale expr.
        const updated = updateGoal(cron.id, { schedule: { kind: "once", at: 456 }, text: "deps once" });
        expect(updated).toMatchObject({ kind: "once", at: 456, text: "deps once" });
        expect((updated as { expr?: string }).expr).toBeUndefined();

        expect(deleteGoal(once.id)).toBe(true);
        expect(deleteGoal(once.id)).toBe(false);
        expect(listGoals().length).toBe(2);
    });

    test("run status roundtrip: start marks running, end records status + summary", () => {
        setDbPathForTests(":memory:");
        const goal = addGoal("nightly", "/repo", { kind: "cron", expr: "0 0 * * *" });
        expect(listGoals()[0]?.lastRun).toBeUndefined();

        recordGoalRunStart(goal.id, "sess-1");
        let run = listGoals()[0]?.lastRun;
        expect(run).toMatchObject({ status: "running", sessionId: "sess-1", summary: null });

        recordGoalRunEnd(goal.id, "ok", "all green");
        run = listGoals()[0]?.lastRun;
        expect(run).toMatchObject({ status: "ok", sessionId: "sess-1", summary: "all green" });
    });

    test("caps at MAX_GOALS", () => {
        setDbPathForTests(":memory:");
        for (let i = 0; i < MAX_GOALS; i++) addGoal(`g${i}`, "/repo", { kind: "none" });
        expect(() => addGoal("one too many", "/repo", { kind: "none" })).toThrow(GoalLimitError);
    });
});

describe("isGoalDue", () => {
    const NOW = 1_000_000;
    const base = { id: "g", text: "t", cwd: "/repo", enabled: true, createdAt: NOW - 10_000 };
    // Fake cron math: fires every 1000ms after `after`.
    const everySecond = (_expr: string, after: number) => after + 1000;
    const never = () => null;

    test("standing and disabled goals are never due", () => {
        expect(isGoalDue({ ...base, kind: "none" }, NOW, everySecond)).toBe(false);
        expect(isGoalDue({ ...base, kind: "once", at: NOW - 1, enabled: false }, NOW, everySecond)).toBe(false);
    });

    test("once: due when past and unran, not after a completed run", () => {
        const goal: Goal = { ...base, kind: "once", at: NOW - 1 };
        expect(isGoalDue(goal, NOW, never)).toBe(true);
        expect(isGoalDue({ ...base, kind: "once", at: NOW + 1 }, NOW, never)).toBe(false);
        expect(
            isGoalDue({ ...goal, lastRun: { at: NOW - 5, sessionId: "s", status: "ok", summary: null } }, NOW, never),
        ).toBe(false);
    });

    test("cron: due when next run after the last is in the past", () => {
        const goal: Goal = { ...base, kind: "cron", expr: "x" };
        expect(isGoalDue(goal, NOW, everySecond)).toBe(true); // createdAt + 1000 << NOW
        expect(
            isGoalDue(
                { ...goal, lastRun: { at: NOW - 500, sessionId: "s", status: "ok", summary: null } },
                NOW,
                everySecond,
            ),
        ).toBe(false); // next = NOW + 500
        expect(isGoalDue(goal, NOW, never)).toBe(false); // dead expression
    });

    test("a fresh running run blocks; a stale one is treated as crashed", () => {
        const goal: Goal = { ...base, kind: "cron", expr: "x" };
        const fresh = { at: NOW - 1000, sessionId: "s", status: "running" as const, summary: null };
        expect(isGoalDue({ ...goal, lastRun: fresh }, NOW, everySecond)).toBe(false);
        const stale = { ...fresh, at: NOW - STALE_RUN_MS - 1 };
        expect(isGoalDue({ ...goal, lastRun: stale }, NOW, everySecond)).toBe(true);
    });
});
