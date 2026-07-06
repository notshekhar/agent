/**
 * Persistent goals — the `goals` table in the session DB. A goal is a stored
 * background task tied to a directory. Unscheduled goals ("none") run
 * on demand (the TUI fires them immediately on quick-add); scheduled goals
 * ("once" absolute timestamp, "cron" expression stored verbatim) are executed
 * headless by the goals daemon (`loop goals tick`). Scheduling/firing is the
 * CLI's job; this module only persists — cron math is injected into isGoalDue
 * so core stays croner-free, same split as reminders.
 *
 * Unlike reminders, goals carry run history (last_run_*): each run records
 * its session so the manager can show status and resume the transcript.
 */
import { ulid } from "ulid";
import { getDb } from "./sessions/db";

export type GoalSchedule = { kind: "none" } | { kind: "once"; at: number } | { kind: "cron"; expr: string };

export type GoalRunStatus = "running" | "ok" | "error";

export interface GoalLastRun {
    at: number;
    sessionId: string | null;
    status: GoalRunStatus;
    summary: string | null;
}

export type Goal = GoalSchedule & {
    id: string;
    text: string;
    cwd: string;
    model?: string;
    /** Agent the goal runs under; unset = the global agent setting at run time. */
    agent?: string;
    enabled: boolean;
    createdAt: number;
    lastRun?: GoalLastRun;
};

/** Hard cap on stored goals — keeps the manager list and tick scan small. */
export const MAX_GOALS = 20;

/** A run older than this with status "running" is a crashed tick — treat as runnable again. */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;

// Keyed on the Database instance so a swapped DB (setDbPathForTests, closeDb)
// self-invalidates instead of serving the old file's list.
let cache: { db: unknown; list: Goal[] } | null = null;

interface GoalRow {
    pub_id: string;
    text: string;
    cwd: string;
    model: string | null;
    agent: string | null;
    kind: string;
    at: number | null;
    expr: string | null;
    enabled: number;
    created_at: number;
    last_run_at: number | null;
    last_run_session_id: string | null;
    last_run_status: string | null;
    last_run_summary: string | null;
}

function rowToGoal(r: GoalRow): Goal {
    const schedule: GoalSchedule =
        r.kind === "cron"
            ? { kind: "cron", expr: r.expr ?? "" }
            : r.kind === "once"
              ? { kind: "once", at: r.at ?? 0 }
              : { kind: "none" };
    const goal: Goal = {
        id: r.pub_id,
        text: r.text,
        cwd: r.cwd,
        enabled: r.enabled === 1,
        createdAt: r.created_at,
        ...schedule,
    };
    if (r.model) goal.model = r.model;
    if (r.agent) goal.agent = r.agent;
    if (r.last_run_at != null && r.last_run_status) {
        goal.lastRun = {
            at: r.last_run_at,
            sessionId: r.last_run_session_id,
            status: r.last_run_status as GoalRunStatus,
            summary: r.last_run_summary,
        };
    }
    return goal;
}

const SELECT_COLS =
    "pub_id, text, cwd, model, agent, kind, at, expr, enabled, created_at, last_run_at, last_run_session_id, last_run_status, last_run_summary";

export function listGoals(cwd?: string): Goal[] {
    const db = getDb();
    if (!cache || cache.db !== db) {
        cache = {
            db,
            list: db
                .query<GoalRow, []>(`SELECT ${SELECT_COLS} FROM goals ORDER BY id`)
                .all()
                .map(rowToGoal),
        };
    }
    return cwd === undefined ? cache.list : cache.list.filter((g) => g.cwd === cwd);
}

/** External-write escape hatch: drop the cache so the next read hits the DB. */
export function refreshGoals(): void {
    cache = null;
}

export class GoalLimitError extends Error {
    constructor() {
        super(`goal limit reached (max ${MAX_GOALS})`);
        this.name = "GoalLimitError";
    }
}

export interface AddGoalOptions {
    model?: string;
    agent?: string;
}

export function addGoal(text: string, cwd: string, schedule: GoalSchedule, opts: AddGoalOptions = {}): Goal {
    if (listGoals().length >= MAX_GOALS) throw new GoalLimitError();
    const goal: Goal = { id: ulid(), text, cwd, enabled: true, createdAt: Date.now(), ...schedule };
    if (opts.model) goal.model = opts.model;
    if (opts.agent) goal.agent = opts.agent;
    getDb().run(
        "INSERT INTO goals (pub_id, text, cwd, model, agent, kind, at, expr, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        [
            goal.id,
            text,
            cwd,
            opts.model ?? null,
            opts.agent ?? null,
            schedule.kind,
            schedule.kind === "once" ? schedule.at : null,
            schedule.kind === "cron" ? schedule.expr : null,
            goal.createdAt,
        ],
    );
    cache = null;
    return goal;
}

export interface GoalPatch {
    text?: string;
    enabled?: boolean;
    model?: string | null;
    agent?: string | null;
    /** Replaces the schedule wholesale, so a kind switch leaves no stale fields. */
    schedule?: GoalSchedule;
}

export function updateGoal(id: string, patch: GoalPatch): Goal | undefined {
    const current = listGoals().find((g) => g.id === id);
    if (!current) return undefined;
    const schedule: GoalSchedule =
        patch.schedule ??
        (current.kind === "once"
            ? { kind: "once", at: current.at }
            : current.kind === "cron"
              ? { kind: "cron", expr: current.expr }
              : { kind: "none" });
    const model = patch.model === undefined ? (current.model ?? null) : patch.model;
    const agent = patch.agent === undefined ? (current.agent ?? null) : patch.agent;
    getDb().run(
        "UPDATE goals SET text = ?, enabled = ?, model = ?, agent = ?, kind = ?, at = ?, expr = ? WHERE pub_id = ?",
        [
            patch.text ?? current.text,
            (patch.enabled ?? current.enabled) ? 1 : 0,
            model,
            agent,
            schedule.kind,
            schedule.kind === "once" ? schedule.at : null,
            schedule.kind === "cron" ? schedule.expr : null,
            id,
        ],
    );
    cache = null;
    return listGoals().find((g) => g.id === id);
}

export function deleteGoal(id: string): boolean {
    const res = getDb().run("DELETE FROM goals WHERE pub_id = ?", [id]);
    cache = null;
    return res.changes > 0;
}

/** Stamp a run as started so a concurrent tick skips this goal. */
export function recordGoalRunStart(id: string, sessionId: string): void {
    getDb().run(
        "UPDATE goals SET last_run_at = ?, last_run_session_id = ?, last_run_status = 'running', last_run_summary = NULL WHERE pub_id = ?",
        [Date.now(), sessionId, id],
    );
    cache = null;
}

export function recordGoalRunEnd(id: string, status: "ok" | "error", summary: string | null): void {
    getDb().run("UPDATE goals SET last_run_status = ?, last_run_summary = ? WHERE pub_id = ?", [
        status,
        summary,
        id,
    ]);
    cache = null;
}

/**
 * Pure due-check; cron math injected (croner lives in the CLI). "once" is due
 * when its time has passed and it never ran; "cron" when the next run after
 * the last one is in the past. A goal mid-run is skipped unless the run is
 * stale (crashed tick).
 */
export function isGoalDue(
    goal: Goal,
    now: number,
    nextCronRun: (expr: string, after: number) => number | null,
): boolean {
    if (!goal.enabled || goal.kind === "none") return false;
    if (goal.lastRun?.status === "running" && now - goal.lastRun.at < STALE_RUN_MS) return false;
    if (goal.kind === "once") return goal.at <= now && (!goal.lastRun || goal.lastRun.status === "running");
    const after = goal.lastRun?.at ?? goal.createdAt;
    const next = nextCronRun(goal.expr, after);
    return next !== null && next <= now;
}
