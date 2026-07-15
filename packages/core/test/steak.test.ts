import { describe, expect, test } from "bun:test";
import { buildSteakGrid } from "../src/agent/steak";

// A fixed "today" so the trailing-window math is deterministic. 2026-06-28 is a
// Sunday, so it sits in row 0 of the final column.
const NOW = new Date(2026, 5, 28);

describe("buildSteakGrid", () => {
    test("trailing window is 53 columns of 7 weekdays", () => {
        const g = buildSteakGrid(new Map(), { now: NOW });
        expect(g.weeks).toBe(53);
        expect(g.cells.length).toBe(7);
        expect(g.cells[0].length).toBe(53);
    });

    test("future days after today render as blank (-1)", () => {
        const g = buildSteakGrid(new Map(), { now: NOW });
        const last = g.weeks - 1;
        // Today is Sunday → row 0 of the final column is in range, Mon..Sat are future.
        expect(g.cells[0][last]).toBe(0); // Sunday, in range, no usage
        expect(g.cells[1][last]).toBe(-1); // Monday, future
        expect(g.cells[6][last]).toBe(-1); // Saturday, future
    });

    test("totals and quartile buckets reflect per-day tokens", () => {
        const daily = new Map<string, number>([
            ["2026-06-28", 4_000_000], // today, heaviest
            ["2026-06-27", 1000],
            ["2026-06-26", 50_000],
            ["2026-06-25", 200_000],
        ]);
        const g = buildSteakGrid(daily, { now: NOW });
        expect(g.totalTokens).toBe(4_251_000);
        // Find the level for the heaviest day — it must be the top bucket.
        const top = g.cells[0][g.weeks - 1]; // 2026-06-28 (Sunday, last col)
        expect(top).toBe(4);
        // Thresholds are monotonic.
        const [q1, q2, q3] = g.thresholds;
        expect(q1).toBeLessThanOrEqual(q2);
        expect(q2).toBeLessThanOrEqual(q3);
    });

    test("year mode spans Jan..Dec as a solid rectangle (past padding fills)", () => {
        const g = buildSteakGrid(new Map(), { year: 2025, now: NOW });
        // 2025-01-01 is a Wednesday. The leading Sun/Mon/Tue of col 0 are out of
        // range but in the past, so they render as empty squares (0), not blanks,
        // keeping the grid rectangular.
        expect(g.cells[0][0]).toBe(0);
        expect(g.cells[3][0]).toBe(0); // Wednesday Jan 1, in range
        expect(g.monthLabels.filter(Boolean)).toContain("Dec");
    });

    test("a past calendar year has no blank (future) cells", () => {
        const g = buildSteakGrid(new Map(), { year: 2024, now: NOW });
        const hasBlank = g.cells.some((row) => row.some((lvl) => lvl === -1));
        expect(hasBlank).toBe(false);
    });

    test("current-year mode draws the full frame — future days are empty, not blank", () => {
        const g = buildSteakGrid(new Map(), { year: 2026, now: NOW });
        const hasBlank = g.cells.some((row) => row.some((lvl) => lvl === -1));
        expect(hasBlank).toBe(false);
        // A clearly future in-range day (Dec 2026) is an empty square, not blank.
        expect(g.cells[1][g.weeks - 2]).toBe(0);
    });

    test("streak stats: runs, active days, and the busiest day", () => {
        const daily = new Map<string, number>([
            // 3-day run ending yesterday…
            ["2026-06-25", 200_000],
            ["2026-06-26", 50_000],
            ["2026-06-27", 1000],
            // …and an older, longer 4-day run.
            ["2026-06-01", 10],
            ["2026-06-02", 10],
            ["2026-06-03", 10],
            ["2026-06-04", 4_000_000],
        ]);
        const g = buildSteakGrid(daily, { now: NOW });
        // Today (06-28, quiet so far) doesn't break the trailing run.
        expect(g.stats.currentStreak).toBe(3);
        expect(g.stats.longestStreak).toBe(4);
        expect(g.stats.activeDays).toBe(7);
        expect(g.stats.busiestDay).toBe("2026-06-04");
        expect(g.stats.busiestDayTokens).toBe(4_000_000);
    });

    test("streak stats: usage today extends the current streak", () => {
        const daily = new Map<string, number>([
            ["2026-06-27", 500],
            ["2026-06-28", 500], // today
        ]);
        const g = buildSteakGrid(daily, { now: NOW });
        expect(g.stats.currentStreak).toBe(2);
        expect(g.stats.longestStreak).toBe(2);
    });

    test("streak stats: empty history is all zeros", () => {
        const g = buildSteakGrid(new Map(), { now: NOW });
        expect(g.stats).toEqual({
            currentStreak: 0,
            longestStreak: 0,
            activeDays: 0,
            busiestDay: "",
            busiestDayTokens: 0,
        });
    });
});
