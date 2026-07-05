/**
 * Persistent reminders — the `reminders` table in the session DB
 * (reminders.json was migrated in and stays on disk unread). A reminder is
 * one-shot ("once", absolute timestamp) or recurring ("cron", up to 6-field
 * second-level expression, stored verbatim). Scheduling/firing is the CLI's
 * job; this module only persists. There is deliberately no seen/missed
 * tracking — reminders fire only while loop is open.
 *
 * The in-memory cache stays: the 1s ticker reads the list twice a second
 * (tickerNeeded + checkReminders), and the DB is the persistence layer, not
 * a thing to poll — the cache invalidates on this process's writes.
 */
import { ulid } from "ulid";
import { getDb } from "./sessions/db";

export type ReminderSchedule = { kind: "once"; at: number } | { kind: "cron"; expr: string };

export type Reminder = ReminderSchedule & {
    id: string;
    text: string;
    enabled: boolean;
};

/** Hard cap on stored reminders — keeps the manager list and ticker scan small. */
export const MAX_REMINDERS = 10;

// Keyed on the Database instance so a swapped DB (setDbPathForTests, closeDb)
// self-invalidates instead of serving the old file's list.
let cache: { db: unknown; list: Reminder[] } | null = null;

interface ReminderRow {
    pub_id: string;
    text: string;
    enabled: number;
    kind: string;
    at: number | null;
    expr: string | null;
}

function rowToReminder(r: ReminderRow): Reminder {
    const base = { id: r.pub_id, text: r.text, enabled: r.enabled === 1 };
    return r.kind === "cron" ? { ...base, kind: "cron", expr: r.expr ?? "" } : { ...base, kind: "once", at: r.at ?? 0 };
}

export function listReminders(): Reminder[] {
    const db = getDb();
    if (!cache || cache.db !== db) {
        cache = {
            db,
            list: db
                .query<ReminderRow, []>("SELECT pub_id, text, enabled, kind, at, expr FROM reminders ORDER BY id")
                .all()
                .map(rowToReminder),
        };
    }
    return cache.list;
}

/** External-write escape hatch: drop the cache so the next read hits the DB. */
export function refreshReminders(): void {
    cache = null;
}

export class ReminderLimitError extends Error {
    constructor() {
        super(`reminder limit reached (max ${MAX_REMINDERS})`);
        this.name = "ReminderLimitError";
    }
}

export function addReminder(text: string, schedule: ReminderSchedule): Reminder {
    if (listReminders().length >= MAX_REMINDERS) throw new ReminderLimitError();
    const reminder: Reminder = { id: ulid(), text, enabled: true, ...schedule };
    getDb().run(
        "INSERT INTO reminders (pub_id, text, enabled, kind, at, expr, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)",
        [
            reminder.id,
            text,
            schedule.kind,
            schedule.kind === "once" ? schedule.at : null,
            schedule.kind === "cron" ? schedule.expr : null,
            Date.now(),
        ],
    );
    cache = null;
    return reminder;
}

export interface ReminderPatch {
    text?: string;
    enabled?: boolean;
    /** Replaces the schedule wholesale, so a kind switch leaves no stale fields. */
    schedule?: ReminderSchedule;
}

export function updateReminder(id: string, patch: ReminderPatch): Reminder | undefined {
    const current = listReminders().find((r) => r.id === id);
    if (!current) return undefined;
    const schedule: ReminderSchedule =
        patch.schedule ??
        (current.kind === "once" ? { kind: "once", at: current.at } : { kind: "cron", expr: current.expr });
    const updated: Reminder = {
        id: current.id,
        text: patch.text ?? current.text,
        enabled: patch.enabled ?? current.enabled,
        ...schedule,
    };
    getDb().run("UPDATE reminders SET text = ?, enabled = ?, kind = ?, at = ?, expr = ? WHERE pub_id = ?", [
        updated.text,
        updated.enabled ? 1 : 0,
        schedule.kind,
        schedule.kind === "once" ? schedule.at : null,
        schedule.kind === "cron" ? schedule.expr : null,
        id,
    ]);
    cache = null;
    return updated;
}

export function deleteReminder(id: string): boolean {
    const res = getDb().run("DELETE FROM reminders WHERE pub_id = ?", [id]);
    cache = null;
    return res.changes > 0;
}
