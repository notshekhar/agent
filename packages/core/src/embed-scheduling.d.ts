/**
 * Reminders and background tasks, for an embedder.
 *
 * Declared rather than inferred from source for the reason in ./embed.d.ts.
 * These mirror `reminders.ts` and `goals.ts` exactly, and
 * `test/embed-scheduling.test.ts` asserts the runtime still matches — so a
 * change there fails core's own suite instead of drifting silently.
 */
declare module "@notshekhar/loop-core/embed-scheduling" {
  export type ReminderSchedule = { kind: "once"; at: number } | { kind: "cron"; expr: string };

  export type Reminder = ReminderSchedule & {
    id: string;
    text: string;
    enabled: boolean;
  };

  export interface ReminderPatch {
    text?: string;
    enabled?: boolean;
    schedule?: ReminderSchedule;
  }

  export const MAX_REMINDERS: number;
  export function listReminders(): Reminder[];
  export function addReminder(text: string, schedule: ReminderSchedule): Reminder;
  export function updateReminder(id: string, patch: ReminderPatch): Reminder | undefined;
  export function deleteReminder(id: string): boolean;
  export function refreshReminders(): void;

  export type GoalSchedule =
    | { kind: "none" }
    | { kind: "once"; at: number }
    | { kind: "cron"; expr: string };

  export interface GoalLastRun {
    at: number;
    sessionId: string | null;
    status: "running" | "ok" | "error";
    summary: string | null;
  }

  export type Goal = GoalSchedule & {
    id: string;
    text: string;
    cwd: string;
    model?: string;
    agent?: string;
    enabled: boolean;
    createdAt: number;
    lastRun?: GoalLastRun;
  };

  export interface AddGoalOptions {
    model?: string;
    agent?: string;
  }

  export interface GoalPatch {
    text?: string;
    enabled?: boolean;
    model?: string | null;
    agent?: string | null;
    schedule?: GoalSchedule;
  }

  export const MAX_GOALS: number;
  export function listGoals(cwd?: string): Goal[];
  export function addGoal(
    text: string,
    cwd: string,
    schedule: GoalSchedule,
    opts?: AddGoalOptions,
  ): Goal;
  export function updateGoal(id: string, patch: GoalPatch): Goal | undefined;
  export function deleteGoal(id: string): boolean;
  export function refreshGoals(): void;
}
