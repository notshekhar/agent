/**
 * /goal — background tasks and scheduled runs. Bare /goal opens the manager
 * (same selector CRUD flow as /reminder); `/goal <text>` parses the text and
 * either runs it immediately in the background (no time mentioned) or
 * schedules it (once/cron, executed by the goals daemon —
 * `<product> goals daemon install`). Background runs are detached headless
 * processes so the TUI never blocks on them.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { SelectItem } from "@notshekhar/loop-tui";
import chalk from "chalk";
import {
    addGoal,
    deleteGoal,
    GoalLimitError,
    listAgents,
    listGoals,
    MAX_GOALS,
    parseGoalInput,
    PRODUCT_NAME,
    refreshGoals,
    toGoalSchedule,
    updateGoal,
    type CommandContext,
    type Goal,
    type GoalSchedule,
} from "@notshekhar/loop-core";
import { Cron } from "croner";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { formatWhen, parseOnceWhen } from "../time";
import { daemonInstall, daemonStatus, daemonUninstall, isDaemonInstalled } from "../../goals/daemon";
import { nextCronRun } from "../../goals/schedule";
import { resumeSessionById } from "./session-handlers";

type GoalHandlers = Pick<CommandContext, "manageGoals" | "manageDaemon">;

const ADD = "\x00add";

export function createGoalHandlers(state: AppState, deps: AppDeps): GoalHandlers {
    const { tui, history, selectOnce, searchOnce, promptOnce, showWorking, hideWorking, tracker } = deps;

    const say = (text: string) => {
        history.addSystem(text);
        tui.requestRender();
    };

    /** Prompt for a schedule: on-demand (none), once, or cron. Null = cancelled. */
    async function promptSchedule(initial?: Goal): Promise<GoalSchedule | null> {
        const kind = await selectOnce(
            [
                { value: "none", label: "on demand", description: "no schedule — run in the background when you say so" },
                { value: "once", label: "once", description: "10m · 18:30 · 2026-06-15 09:00" },
                { value: "cron", label: "cron", description: "e.g. 0 9 * * 1-5 (weekdays 9:00)" },
            ],
            "Goal schedule",
        );
        if (!kind) return null;
        if (kind.value === "none") return { kind: "none" };

        if (kind.value === "once") {
            const raw = await promptOnce("when (10m / 18:30 / 2026-06-15 09:00)");
            const at = parseOnceWhen(raw);
            if (at === null || at <= Date.now()) {
                say(chalk.red(`can't parse a future time from: ${raw}`));
                return null;
            }
            return { kind: "once", at };
        }

        const expr = (await promptOnce("cron expression", initial?.kind === "cron" ? initial.expr : "")).trim();
        if (!expr) return null;
        try {
            new Cron(expr); // validate only — firing is the daemon's job
        } catch {
            say(chalk.red(`invalid cron expression: ${expr}`));
            return null;
        }
        return { kind: "cron", expr };
    }

    function scheduleLabel(g: Goal): string {
        const when = g.kind === "once" ? `once ${formatWhen(g.at)}` : g.kind === "cron" ? `cron ${g.expr}` : "on demand";
        return `${when}${g.enabled ? "" : "  (off)"}`;
    }

    function describeSchedule(schedule: GoalSchedule): string {
        if (schedule.kind === "once") return `once ${formatWhen(schedule.at)}`;
        if (schedule.kind === "cron") {
            const next = nextCronRun(schedule.expr, Date.now());
            return `cron ${schedule.expr}${next ? ` · next ${formatWhen(next)}` : ""}`;
        }
        return "run now in the background";
    }

    /** The session's agent unless the parse pinned a valid one. */
    function resolveAgent(parsedAgent: string | null | undefined): string | undefined {
        if (parsedAgent && listAgents().some((a) => a.name === parsedAgent)) return parsedAgent;
        return state.agent === "default" ? undefined : state.agent;
    }

    /**
     * AI quick-add: parse the raw text into objective + schedule + agent,
     * confirm before acting. No time mentioned = run in the background NOW
     * (matching how background tasks work everywhere else); a time makes it a
     * scheduled goal for the daemon. On parse failure the goal is saved
     * without running — a garbled schedule must not trigger unattended work —
     * and /goal <text> never errors out.
     */
    async function quickAdd(raw: string): Promise<void> {
        if (listGoals().length >= MAX_GOALS) {
            say(chalk.yellow(`goal limit reached (max ${MAX_GOALS}) — delete one first`));
            return;
        }
        const fallback = (note: string) => {
            const goal = addGoal(raw, state.cwd, { kind: "none" }, { agent: resolveAgent(null) });
            say(`${chalk.dim(note)}\nsaved — run or schedule it in /goal: ${goal.text}`);
        };

        showWorking("Parsing goal");
        tui.requestRender();
        let text = raw;
        let schedule: GoalSchedule | null = null;
        let agent: string | undefined;
        try {
            const parsed = await parseGoalInput({
                raw,
                modelId: state.modelId,
                agentNames: listAgents().map((a) => a.name),
                tracker,
                cwd: state.cwd,
                sessionPub: state.session?.id,
                abortSignal: AbortSignal.timeout(8_000),
            });
            schedule = toGoalSchedule(parsed, Date.now());
            if (schedule?.kind === "cron") {
                try {
                    new Cron(schedule.expr);
                } catch {
                    schedule = null; // model produced a dead expression
                }
            }
            if (parsed.text.trim()) text = parsed.text.trim();
            agent = resolveAgent(parsed.agent);
        } catch {
            schedule = null;
        } finally {
            hideWorking();
        }
        if (!schedule) {
            fallback("couldn't parse that");
            return;
        }

        const detail = [describeSchedule(schedule), agent ? `agent ${agent}` : ""].filter(Boolean).join("  ·  ");
        const choice = await selectOnce(
            [
                {
                    value: "save",
                    label: schedule.kind === "none" ? "run in background" : "save",
                    description: detail,
                },
                { value: "schedule", label: "edit schedule", description: describeSchedule(schedule) },
                { value: "cancel", label: "cancel" },
            ],
            `goal: ${text}`,
        );
        if (!choice || choice.value === "cancel") return;
        if (choice.value === "schedule") {
            const edited = await promptSchedule();
            if (!edited) return;
            schedule = edited;
        }
        const goal = addGoal(text, state.cwd, schedule, { agent });
        if (schedule.kind === "none") {
            runNowDetached(goal);
            return;
        }
        say(`goal added — ${goal.text}  ·  ${describeSchedule(schedule)}${goal.agent ? `  ·  agent ${goal.agent}` : ""}`);
        if (!isDaemonInstalled()) {
            say(chalk.yellow("the goals daemon is off — this goal will NOT run on its own. Turn it on with /daemon"));
        }
    }

    function lastRunLabel(g: Goal): string {
        if (g.kind !== "none" && !g.lastRun) return "never ran";
        if (!g.lastRun) return "";
        return `last run ${g.lastRun.status} ${formatWhen(g.lastRun.at)}`;
    }

    /** Headless run in a detached child — its own DB writes + notification. */
    function runNowDetached(goal: Goal): void {
        const exe = process.execPath;
        const argv = basename(exe).toLowerCase().startsWith("bun")
            ? [Bun.main ?? process.argv[1] ?? "", "goals", "run", goal.id]
            : ["goals", "run", goal.id];
        const child = spawn(exe, argv, { stdio: "ignore", detached: true });
        child.on("error", (e) => say(chalk.red(`could not start goal run: ${e.message}`)));
        child.unref();
        say(chalk.dim(`running in background — you'll get a notification (${PRODUCT_NAME} goals list for status)`));
    }

    async function openManager(): Promise<void> {
        // Scheduled goals silently never fire without the OS scheduler — warn
        // up front instead of letting the user discover a "never ran" later.
        refreshGoals();
        if (
            listGoals().some((g) => g.enabled && g.kind !== "none") &&
            !isDaemonInstalled()
        ) {
            say(
                chalk.yellow(
                    "scheduled goals exist but the daemon is off — they will not run on their own. Turn it on with /daemon",
                ),
            );
        }
        let lastIndex = 0;
        while (true) {
            refreshGoals(); // a daemon tick may have updated run status since the last look
            const goals = listGoals();
            const items: SelectItem[] = [
                { value: ADD, label: "+ add goal…", description: "on demand, once, or cron-scheduled" },
                ...goals.map((g) => ({
                    value: g.id,
                    label: g.text,
                    description: [
                        scheduleLabel(g),
                        g.agent ? `agent ${g.agent}` : "",
                        lastRunLabel(g),
                        g.cwd !== state.cwd ? g.cwd : "",
                    ]
                        .filter(Boolean)
                        .join("  ·  "),
                })),
            ];
            const pick = await searchOnce(items, `Goals · ${goals.length}`, { initialIndex: lastIndex });
            if (!pick) return;
            lastIndex = Math.max(
                0,
                items.findIndex((i) => i.value === pick.value),
            );

            if (pick.value === ADD) {
                if (goals.length >= MAX_GOALS) {
                    say(chalk.yellow(`goal limit reached (max ${MAX_GOALS}) — delete one first`));
                    continue;
                }
                const text = (await promptOnce("goal")).trim();
                if (!text) continue;
                const schedule = await promptSchedule();
                if (!schedule) continue;
                addGoal(text, state.cwd, schedule);
                say(`goal added — ${text}`);
                if (schedule.kind !== "none" && !isDaemonInstalled()) {
                    say(chalk.dim("scheduled goals need the daemon — turn it on with /daemon"));
                }
                continue;
            }

            const goal = listGoals().find((g) => g.id === pick.value);
            if (!goal) continue;
            const action = await selectOnce(
                [
                    { value: "toggle", label: goal.enabled ? "disable" : "enable" },
                    { value: "text", label: "edit text", description: goal.text },
                    { value: "schedule", label: "edit schedule", description: scheduleLabel(goal) },
                    {
                        value: "model",
                        label: "edit model",
                        description: goal.model ?? "project default",
                    },
                    {
                        value: "agent",
                        label: "edit agent",
                        description: goal.agent ?? "session default",
                    },
                    { value: "run", label: "run now", description: "headless run in the background" },
                    ...(goal.lastRun?.sessionId
                        ? [{ value: "open", label: "open last run", description: lastRunLabel(goal) }]
                        : []),
                    { value: "delete", label: "delete" },
                ],
                goal.text,
            );
            if (!action) continue;

            if (action.value === "toggle") {
                updateGoal(goal.id, { enabled: !goal.enabled });
            } else if (action.value === "text") {
                const text = (await promptOnce("goal", goal.text)).trim();
                if (text) updateGoal(goal.id, { text });
            } else if (action.value === "schedule") {
                const schedule = await promptSchedule(goal);
                if (schedule) updateGoal(goal.id, { schedule, enabled: true });
            } else if (action.value === "model") {
                const raw = (await promptOnce("model (provider/model, empty = project default)", goal.model ?? "")).trim();
                if (!raw) {
                    updateGoal(goal.id, { model: null });
                } else if (!raw.includes("/")) {
                    say(chalk.red(`expected provider/model, got: ${raw}`));
                } else {
                    updateGoal(goal.id, { model: raw });
                }
            } else if (action.value === "agent") {
                const pick = await selectOnce(
                    [
                        { value: "\x00default", label: "session default", description: "use the agent setting at run time" },
                        ...listAgents().map((a) => ({ value: a.name, label: a.name })),
                    ],
                    `agent for: ${goal.text}`,
                );
                if (pick) updateGoal(goal.id, { agent: pick.value === "\x00default" ? null : pick.value });
            } else if (action.value === "run") {
                runNowDetached(goal);
            } else if (action.value === "open" && goal.lastRun?.sessionId) {
                await resumeSessionById(state, deps, goal.lastRun.sessionId);
                return; // the manager's selector is gone once history re-renders
            } else if (action.value === "delete") {
                deleteGoal(goal.id);
            }
        }
    }

    /**
     * /daemon — install/uninstall the OS scheduler that runs scheduled goals.
     * Bare /daemon opens a toggle panel; on|off|status skip it. install is
     * safe to repeat (it re-bootstraps, picking up a moved binary).
     */
    async function manageDaemon(args: string): Promise<void> {
        const arg = args.trim().toLowerCase();
        const installed = isDaemonInstalled();
        let action: string | undefined;
        if (arg === "on" || arg === "install") action = "on";
        else if (arg === "off" || arg === "uninstall") action = "off";
        else if (arg === "status") action = "status";
        else if (arg) {
            say(chalk.red("usage: /daemon [on|off|status]"));
            return;
        } else {
            const pick = await selectOnce(
                [
                    installed
                        ? { value: "off", label: "turn off", description: "uninstall — scheduled goals stop running on their own" }
                        : { value: "on", label: "turn on", description: "install — runs scheduled goals in the background (ticks every minute)" },
                    { value: "status", label: "status", description: "show the OS scheduler state" },
                    { value: "cancel", label: "cancel" },
                ],
                `Goals daemon · ${installed ? "on" : "off"}`,
            );
            if (!pick || pick.value === "cancel") return;
            action = pick.value;
        }
        try {
            if (action === "on") say(daemonInstall());
            else if (action === "off") say(installed ? daemonUninstall() : "goals daemon is not installed");
            else say(daemonStatus());
        } catch (err) {
            say(chalk.red((err as Error).message));
        }
    }

    return {
        async manageGoals(args: string) {
            const text = args.trim();
            if (!text) {
                await openManager();
                return;
            }
            try {
                await quickAdd(text);
            } catch (err) {
                if (err instanceof GoalLimitError) say(chalk.yellow(err.message));
                else throw err;
            }
        },
        manageDaemon,
    };
}
