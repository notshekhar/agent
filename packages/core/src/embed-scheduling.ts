/**
 * Reminders and background tasks, for an embedder.
 *
 * A narrow entry point rather than the package root, for the same reason
 * `./embed` exists: the root barrel re-exports `./datasources`, whose
 * `import { SQL } from "bun"` used to be evaluated on load and is fatal under
 * Node. These two modules touch nothing but the session database, so they are
 * safe to import from Electron's main process.
 *
 * Nothing new is implemented here — this is a re-export so the desktop app and
 * the terminal call exactly the same functions and cannot drift.
 */
export {
    addReminder,
    deleteReminder,
    listReminders,
    refreshReminders,
    updateReminder,
    MAX_REMINDERS,
    ReminderLimitError,
    type Reminder,
    type ReminderPatch,
    type ReminderSchedule,
} from "./reminders";

export {
    addGoal,
    deleteGoal,
    listGoals,
    refreshGoals,
    updateGoal,
    MAX_GOALS,
    GoalLimitError,
    type AddGoalOptions,
    type Goal,
    type GoalPatch,
    type GoalSchedule,
} from "./goals";
