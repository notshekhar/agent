import { deleteReminder, listReminders, runningShellCount, settingsStore } from "@notshekhar/loop-core";
import { Cron } from "croner";
import { createReminderScheduler, needsLegacyTick } from "./reminder-scheduler";
import type { SelectItem, TUI } from "@notshekhar/loop-tui";
import type { StatusLine } from "./components/status-line";
import type { AppState } from "./state";

export interface TickerDeps {
    state: AppState;
    statusLine: StatusLine;
    tui: TUI;
    /** Open count of selectors — notices wait until the input slot is free. */
    getSelectorDepth: () => number;
    /** Swap an "ok" prompt into the input slot (used to surface a fired notice). */
    selectOnce: (items: SelectItem[], title?: string) => Promise<unknown>;
}

export interface Ticker {
    /** Start/stop the 1s pulse to match what currently needs it, and repaint. */
    syncTicker(): void;
    /** Clear the pulse and every cron registration (shutdown). Idempotent. */
    stopTicker(): void;
}

/**
 * Shared 1s ticker: status line clock, /timer countdown, reminder scheduler. Runs
 * only while one of them needs it, so idle sessions hold no timers. Pulled out
 * of the app orchestrator — it owns all timer/reminder/notice state internally
 * and exposes only syncTicker() to wire up.
 */
export function createTicker(deps: TickerDeps): Ticker {
    const { state, statusLine, tui, getSelectorDepth, selectOnce } = deps;

    let ticker: ReturnType<typeof setInterval> | null = null;
    let lastTickAt = Date.now();
    const notices: string[] = [];
    let noticeShowing = false;

    const remindersMuted = () => settingsStore.get("reminders") === false;

    // Bun.cron fires 5-field reminders and one-shots on its own; the tick below
    // is left with only the sub-minute expressions the built-in cannot express.
    const scheduler = createReminderScheduler({ ring: (title) => ring(title) });

    function tickerNeeded(): boolean {
        const clockOn = settingsStore.get("clock") === true;
        // Only the ones Bun.cron cannot express still need the poll: everything
        // else is registered with the built-in and fires without a pulse.
        const remindersPending = !remindersMuted() && listReminders().some(needsLegacyTick);
        // Keep ticking while notices are queued: a reminder/timer that fired
        // during a turn is held until !busy, and a one-shot reminder deletes
        // itself when it fires — without this the ticker could stop before the
        // turn ends, stranding the notice so it never shows.
        // A running background shell keeps the pulse alive so its elapsed time
        // advances on screen — otherwise a quiet process (a server that has
        // finished booting and says nothing) freezes at the age it had when it
        // last printed.
        const shellsRunning = runningShellCount(state.session?.id) > 0;
        return clockOn || state.timerEndsAt !== null || remindersPending || notices.length > 0 || shellsRunning;
    }

    function syncTicker(): void {
        statusLine.setClockEnabled(settingsStore.get("clock") === true);
        // Reminder rows may have changed (added, edited, muted) since the last
        // call; this is the one place that already runs after every such change.
        scheduler.sync();
        const needed = tickerNeeded();
        if (needed && ticker === null) {
            lastTickAt = Date.now();
            ticker = setInterval(onTick, 1000);
        } else if (!needed && ticker !== null) {
            clearInterval(ticker);
            ticker = null;
        }
        tui.requestRender();
    }

    function onTick(): void {
        const now = Date.now();
        checkTimer(now);
        checkReminders(now);
        lastTickAt = now;
        void drainNotices();
        syncTicker(); // also renders; stops the pulse once nothing needs it
    }

    function checkTimer(now: number): void {
        if (state.timerEndsAt === null || now < state.timerEndsAt) return;
        const label = state.timerLabel;
        state.timerEndsAt = null;
        state.timerLabel = "";
        statusLine.setTimer(null);
        ring(`Timer over — ${label}`);
    }

    /**
     * What Bun.cron could not take: the sub-minute (6-field) expressions. The
     * one-shot branch stays as a safety net for a reminder whose moment passed
     * before the scheduler could arm a timer for it — the same "only if it
     * lapsed during this tick" rule as before, so a deadline missed while loop
     * was closed still never fires.
     */
    function checkReminders(now: number): void {
        if (remindersMuted()) return; // muted: nothing fires, reminders stay stored
        for (const r of listReminders()) {
            if (!r.enabled) continue;
            if (r.kind === "once") {
                if (r.at > lastTickAt && r.at <= now) {
                    ring(`Reminder — ${r.text}`);
                    deleteReminder(r.id); // one-shot: gone after firing; cron ones live on
                }
            } else if (needsLegacyTick(r)) {
                try {
                    const next = new Cron(r.expr).nextRun(new Date(lastTickAt));
                    if (next && next.getTime() <= now) ring(`Reminder — ${r.text}`);
                } catch {
                    // invalid expression — the manager validates on entry; skip
                }
            }
        }
    }

    function ring(title: string): void {
        process.stdout.write("\x07"); // terminal bell
        notices.push(title);
        // Reminders fire from Bun.cron now, which is OUTSIDE the pulse — so
        // nothing else is coming to pick this up. Draining used to be implied
        // by ring() only ever being called from onTick; a queued notice would
        // otherwise sit there unshown while the bell had already rung. Both
        // calls are idempotent, so the in-tick callers are unaffected.
        syncTicker();
        void drainNotices();
    }

    // Time's-up / reminder prompts swap into the input slot like any selector,
    // but only when it's free: never during a streaming turn, never on top of
    // an open picker. Enter (ok) or Esc dismisses; queued ones follow.
    async function drainNotices(): Promise<void> {
        if (noticeShowing) return;
        noticeShowing = true;
        try {
            while (notices.length > 0 && !state.busy && getSelectorDepth() === 0) {
                const title = notices.shift()!;
                await selectOnce([{ value: "ok", label: "ok" }], title);
            }
        } finally {
            noticeShowing = false;
        }
    }

    function stopTicker(): void {
        if (ticker !== null) {
            clearInterval(ticker);
            ticker = null;
        }
        scheduler.stop();
    }

    return { syncTicker, stopTicker };
}
