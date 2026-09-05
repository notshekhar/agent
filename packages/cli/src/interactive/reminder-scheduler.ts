/**
 * Reminder firing, on Bun's built-in cron.
 *
 * Reminders used to ride the shared 1s ticker: every pulse asked croner, per
 * enabled reminder, whether a firing had happened since the last one. That
 * works, but it is a poll — the pulse has to be running for a reminder to fire
 * at all, and the granularity of the answer is the pulse, not the expression.
 *
 * `Bun.cron` fires the callback itself, so a reminder is registered once and
 * arrives on time with no pulse behind it. Two limits of the built-in shape the
 * code here, both measured rather than assumed:
 *
 *   - It is FIVE fields. `{ seconds: true }` does not enable a sixth; a 6-field
 *     expression is rejected outright. loop has always stored "up to 6-field
 *     second-level" expressions (see reminders.ts), so the sub-minute ones stay
 *     on the old croner path rather than being dropped — see needsLegacyTick.
 *   - It has no `nextRun`. Nothing here needs one; goals do, which is why they
 *     are a different problem.
 *
 * One-shots do not go through cron at all: an absolute instant is a timer, and
 * a timer set only for a future moment preserves the existing rule that a
 * deadline which lapsed while loop was closed never fires.
 */
import { deleteReminder, listReminders, settingsStore, type Reminder } from "@notshekhar/loop-core";

/** Bun's cron handle — typed here because bun-types lags the runtime. */
interface CronHandle {
    stop(): void;
    unref(): void;
}
type BunCron = (expr: string, cb: () => void, opts?: unknown) => CronHandle;

const bunCron = (Bun as unknown as { cron?: BunCron }).cron;

/** True when the runtime predates Bun.cron — everything falls back to the tick. */
export const hasBunCron = typeof bunCron === "function";

/**
 * A 6-field expression firing at second 0 means exactly what the 5-field one
 * means, so it converts losslessly. Any other seconds field is genuinely
 * sub-minute (or offset) and has no 5-field equivalent.
 */
export function toBunCronExpr(expr: string): string | null {
    const fields = expr.trim().split(/\s+/);
    if (fields.length === 5) return expr.trim();
    if (fields.length === 6 && fields[0] === "0") return fields.slice(1).join(" ");
    return null;
}

/** Reminders Bun.cron cannot express, which the 1s ticker still has to poll. */
export function needsLegacyTick(r: Reminder): boolean {
    if (!r.enabled || r.kind !== "cron") return false;
    return !hasBunCron || toBunCronExpr(r.expr) === null;
}

export interface ReminderSchedulerDeps {
    /** Fire a notice — the same ring() the ticker uses, so presentation is shared. */
    ring: (title: string) => void;
    /** Stored reminders. Injectable so the teardown paths are testable. */
    list?: () => Reminder[];
    /** Whether reminders are muted. Injectable for the same reason. */
    muted?: () => boolean;
}

export interface ReminderScheduler {
    /**
     * Reconcile registrations against the stored reminders. Cheap and
     * idempotent: call it after any add/update/delete/mute, and at startup.
     */
    sync(): void;
    /** Drop every registration (shutdown). Idempotent. */
    stop(): void;
    /** How many reminders are currently armed — the teardown paths are
     * otherwise invisible, and "off" has to be provable. */
    registeredCount(): number;
}

export function createReminderScheduler(deps: ReminderSchedulerDeps): ReminderScheduler {
    /** Keyed by reminder id; `key` is what was registered, so a change re-registers. */
    const cronJobs = new Map<string, { key: string; handle: CronHandle }>();
    const onceTimers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

    const list = deps.list ?? listReminders;
    const muted = deps.muted ?? (() => settingsStore.get("reminders") === false);

    const clearOne = (id: string): void => {
        cronJobs.get(id)?.handle.stop();
        cronJobs.delete(id);
        const t = onceTimers.get(id);
        if (t) clearTimeout(t.timer);
        onceTimers.delete(id);
    };

    function sync(): void {
        if (!hasBunCron) return stop();
        if (muted()) return stop(); // muted: nothing fires, reminders stay stored

        const live = new Set<string>();
        for (const r of list()) {
            if (!r.enabled) continue;

            if (r.kind === "once") {
                // Only ever scheduled forward. A lapsed deadline is not fired
                // on startup — that is the existing rule, kept.
                const delay = r.at - Date.now();
                if (delay <= 0) continue;
                live.add(r.id);
                const existing = onceTimers.get(r.id);
                if (existing?.at === r.at) continue;
                if (existing) clearTimeout(existing.timer);
                const timer = setTimeout(() => {
                    onceTimers.delete(r.id);
                    deps.ring(`Reminder — ${r.text}`);
                    deleteReminder(r.id); // one-shot: gone after firing
                }, delay);
                // Never hold the process open for a reminder.
                timer.unref?.();
                onceTimers.set(r.id, { at: r.at, timer });
                continue;
            }

            const expr = toBunCronExpr(r.expr);
            if (expr === null) continue; // sub-minute: the ticker still polls it
            live.add(r.id);
            const existing = cronJobs.get(r.id);
            if (existing?.key === expr) continue;
            existing?.handle.stop();
            try {
                const handle = bunCron!(expr, () => deps.ring(`Reminder — ${r.text}`));
                handle.unref();
                cronJobs.set(r.id, { key: expr, handle });
            } catch {
                // Rejected by Bun despite converting — leave it to the ticker.
                cronJobs.delete(r.id);
            }
        }

        for (const id of [...cronJobs.keys(), ...onceTimers.keys()]) {
            if (!live.has(id)) clearOne(id);
        }
    }

    function stop(): void {
        for (const id of [...cronJobs.keys(), ...onceTimers.keys()]) clearOne(id);
    }

    return { sync, stop, registeredCount: () => cronJobs.size + onceTimers.size };
}
