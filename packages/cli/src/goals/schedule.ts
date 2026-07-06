/**
 * Cron math for goals — the injected half of core's isGoalDue (core stays
 * croner-free, same split as reminders). Also the `--every 30m` sugar that
 * turns a plain interval into a cron expression.
 */
import { Cron } from "croner";
import { isGoalDue, type Goal } from "@notshekhar/loop-core";

/** Epoch ms of the next cron firing strictly after `after`, or null for a dead expression. */
export function nextCronRun(expr: string, after: number): number | null {
    try {
        return new Cron(expr).nextRun(new Date(after))?.getTime() ?? null;
    } catch {
        return null;
    }
}

export function dueGoals(goals: Goal[], now: number): Goal[] {
    return goals.filter((g) => isGoalDue(g, now, nextCronRun));
}

/**
 * `--every` sugar: "30m" / "2h" / "1d" / plain minutes ("45") → a cron
 * expression anchored at minute/hour zero. Returns null on anything it
 * doesn't understand; callers fall back to treating input as cron.
 */
export function everyToCron(spec: string): string | null {
    const m = /^(\d+)\s*(m|min|h|hr|d|day)?s?$/i.exec(spec.trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n <= 0) return null;
    const unit = (m[2] ?? "m").toLowerCase();
    if (unit.startsWith("m")) {
        if (n < 60) return `*/${n} * * * *`;
        if (n % 60 === 0) return `0 */${n / 60} * * *`;
        return null; // 90m etc. has no clean cron equivalent
    }
    if (unit.startsWith("h")) return n < 24 ? `0 */${n} * * *` : n % 24 === 0 ? `0 0 */${n / 24} * *` : null;
    return `0 0 */${n} * *`; // days
}

/** Validate a cron expression the way the reminder manager does. */
export function isValidCron(expr: string): boolean {
    try {
        new Cron(expr);
        return true;
    } catch {
        return false;
    }
}
