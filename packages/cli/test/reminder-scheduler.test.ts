import { describe, expect, test } from "bun:test";
import {
    createReminderScheduler,
    hasBunCron,
    needsLegacyTick,
    toBunCronExpr,
} from "../src/interactive/reminder-scheduler";
import type { Reminder } from "@notshekhar/loop-core";

const cronReminder = (expr: string, enabled = true): Reminder =>
    ({ id: "r1", text: "t", enabled, kind: "cron", expr }) as Reminder;

describe("Bun.cron availability", () => {
    test("the runtime has it — the fast path is live, not dormant", () => {
        expect(hasBunCron).toBe(true);
    });
});

/**
 * Bun.cron is five fields and rejects a sixth outright — `{ seconds: true }`
 * does not change that. loop has always stored "up to 6-field second-level"
 * expressions, so the conversion decides which reminders the built-in can take
 * and which stay on the poll.
 */
describe("toBunCronExpr", () => {
    test("a 5-field expression passes through untouched", () => {
        expect(toBunCronExpr("*/10 * * * *")).toBe("*/10 * * * *");
        expect(toBunCronExpr("  0 9 * * 1-5  ")).toBe("0 9 * * 1-5");
    });

    test("a 6-field expression firing at second 0 converts losslessly", () => {
        // "at second 0 of every 5th minute" IS "every 5th minute".
        expect(toBunCronExpr("0 */5 * * * *")).toBe("*/5 * * * *");
        expect(toBunCronExpr("0 30 9 * * 1")).toBe("30 9 * * 1");
    });

    test("a genuinely sub-minute expression has no 5-field equivalent", () => {
        expect(toBunCronExpr("*/30 * * * * *")).toBeNull();
        expect(toBunCronExpr("15 * * * * *")).toBeNull();
        expect(toBunCronExpr("* * * * * *")).toBeNull();
    });

    test("anything that is not 5 or 6 fields is refused", () => {
        expect(toBunCronExpr("* * * *")).toBeNull();
        expect(toBunCronExpr("* * * * * * *")).toBeNull();
        expect(toBunCronExpr("")).toBeNull();
    });

    test("every converted expression is one Bun.cron actually accepts", () => {
        const bunCron = (Bun as unknown as { cron: (e: string, cb: () => void) => { stop(): void } }).cron;
        for (const expr of ["*/10 * * * *", "0 */5 * * * *", "0 30 9 * * 1", "0 0 1 * *"]) {
            const converted = toBunCronExpr(expr);
            expect(converted).not.toBeNull();
            const handle = bunCron(converted!, () => {});
            handle.stop();
        }
    });
});

/**
 * The pulse is the thing being removed. A session whose reminders are all
 * expressible by the built-in must hold no 1s timer at all.
 */
describe("needsLegacyTick", () => {
    test("expressible reminders no longer need the poll", () => {
        expect(needsLegacyTick(cronReminder("*/10 * * * *"))).toBe(false);
        expect(needsLegacyTick(cronReminder("0 */5 * * * *"))).toBe(false);
    });

    test("sub-minute reminders keep it, so nothing silently stops firing", () => {
        expect(needsLegacyTick(cronReminder("*/30 * * * * *"))).toBe(true);
    });

    test("a disabled reminder never holds the pulse", () => {
        expect(needsLegacyTick(cronReminder("*/30 * * * * *", false))).toBe(false);
    });

    test("one-shots are timers, not cron, so they never hold it", () => {
        expect(needsLegacyTick({ id: "r", text: "t", enabled: true, kind: "once", at: Date.now() } as Reminder)).toBe(
            false,
        );
    });
});

/**
 * Under the old poll, "off" was safe by construction: checkReminders read the
 * setting on every pulse, so muting could not be forgotten. Registrations are
 * different — a handle armed with Bun.cron keeps firing until something stops
 * it. These assert the teardown actually happens.
 */
describe("turning reminders off in /settings", () => {
    const every5: Reminder = { id: "a", text: "standup", enabled: true, kind: "cron", expr: "*/5 * * * *" } as Reminder;
    const soon = (): Reminder =>
        ({ id: "b", text: "tea", enabled: true, kind: "once", at: Date.now() + 60_000 }) as Reminder;

    test("muting stops every registration, and unmuting brings them back", () => {
        let muted = false;
        const fired: string[] = [];
        const s = createReminderScheduler({
            ring: (t) => fired.push(t),
            list: () => [every5, soon()],
            muted: () => muted,
        });

        s.sync();
        expect(s.registeredCount()).toBe(2);

        muted = true;
        s.sync(); // what the /settings toggle triggers via syncTicker
        expect(s.registeredCount()).toBe(0);

        muted = false;
        s.sync();
        expect(s.registeredCount()).toBe(2);
        s.stop();
    });

    test("disabling one reminder drops only that registration", () => {
        let rows: Reminder[] = [every5, soon()];
        const s = createReminderScheduler({ ring: () => {}, list: () => rows, muted: () => false });
        s.sync();
        expect(s.registeredCount()).toBe(2);

        rows = [{ ...every5, enabled: false }, soon()];
        s.sync();
        expect(s.registeredCount()).toBe(1);
        s.stop();
    });

    test("deleting a reminder drops its registration", () => {
        let rows: Reminder[] = [every5];
        const s = createReminderScheduler({ ring: () => {}, list: () => rows, muted: () => false });
        s.sync();
        expect(s.registeredCount()).toBe(1);
        rows = [];
        s.sync();
        expect(s.registeredCount()).toBe(0);
        s.stop();
    });

    test("editing the expression re-registers rather than stacking a second handle", () => {
        let expr = "*/5 * * * *";
        const s = createReminderScheduler({
            ring: () => {},
            list: () => [{ ...every5, expr }],
            muted: () => false,
        });
        s.sync();
        s.sync(); // idempotent — same expression must not add another
        expect(s.registeredCount()).toBe(1);
        expr = "*/10 * * * *";
        s.sync();
        expect(s.registeredCount()).toBe(1);
        s.stop();
    });

    test("stop() clears everything (shutdown)", () => {
        const s = createReminderScheduler({ ring: () => {}, list: () => [every5, soon()], muted: () => false });
        s.sync();
        s.stop();
        expect(s.registeredCount()).toBe(0);
    });
});
