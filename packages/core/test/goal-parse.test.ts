import { describe, expect, test } from "bun:test";
import { toGoalSchedule, type ParsedGoal } from "../src/agent/goal-parse";

const NOW = new Date("2026-07-07T12:00:00").getTime();
const HOUR = 60 * 60 * 1000;

const parsed = (over: Partial<ParsedGoal>): ParsedGoal => ({
    text: "t",
    kind: "none",
    onceInMinutes: null,
    onceAtIso: null,
    cronExpr: null,
    agent: null,
    ...over,
});

describe("toGoalSchedule", () => {
    test("none passes through", () => {
        expect(toGoalSchedule(parsed({ kind: "none" }), NOW)).toEqual({ kind: "none" });
    });

    test("once: relative minutes computed from now, preferred over ISO", () => {
        expect(toGoalSchedule(parsed({ kind: "once", onceInMinutes: 1 }), NOW)).toEqual({
            kind: "once",
            at: NOW + 60_000,
        });
        // Both set (model hedged): the deterministic relative delay wins.
        expect(
            toGoalSchedule(parsed({ kind: "once", onceInMinutes: 45, onceAtIso: "2026-07-07T13:00" }), NOW),
        ).toEqual({ kind: "once", at: NOW + 45 * 60_000 });
        // Garbage delays fall through to the ISO path / rejection.
        expect(toGoalSchedule(parsed({ kind: "once", onceInMinutes: 0 }), NOW)).toBeNull();
        expect(toGoalSchedule(parsed({ kind: "once", onceInMinutes: -5 }), NOW)).toBeNull();
    });

    test("once: future ISO becomes an epoch", () => {
        const s = toGoalSchedule(parsed({ kind: "once", onceAtIso: "2026-07-07T14:30" }), NOW);
        expect(s).toEqual({ kind: "once", at: new Date("2026-07-07T14:30:00").getTime() });
    });

    test("once: a time within the past 24h rolls forward a day", () => {
        const s = toGoalSchedule(parsed({ kind: "once", onceAtIso: "2026-07-07T09:00" }), NOW);
        expect(s).toEqual({ kind: "once", at: new Date("2026-07-07T09:00:00").getTime() + 24 * HOUR });
    });

    test("once: older than 24h or garbage is rejected", () => {
        expect(toGoalSchedule(parsed({ kind: "once", onceAtIso: "2026-07-01T09:00" }), NOW)).toBeNull();
        expect(toGoalSchedule(parsed({ kind: "once", onceAtIso: "not a date" }), NOW)).toBeNull();
        expect(toGoalSchedule(parsed({ kind: "once", onceAtIso: null }), NOW)).toBeNull();
    });

    test("cron: expression passes through trimmed; empty rejected", () => {
        expect(toGoalSchedule(parsed({ kind: "cron", cronExpr: " 0 9 * * * " }), NOW)).toEqual({
            kind: "cron",
            expr: "0 9 * * *",
        });
        expect(toGoalSchedule(parsed({ kind: "cron", cronExpr: null }), NOW)).toBeNull();
        expect(toGoalSchedule(parsed({ kind: "cron", cronExpr: "  " }), NOW)).toBeNull();
    });
});
