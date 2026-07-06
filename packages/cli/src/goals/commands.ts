/**
 * `<product> goals …` — the CLI face of /goal: CRUD, a manual tick, and the
 * OS-scheduler install. The TUI manager (/goal) is the richer surface; this
 * one exists so the daemon has something to invoke and headless boxes can be
 * scripted.
 */
import {
    addGoal,
    closeDb,
    listGoals,
    deleteGoal,
    PRODUCT_NAME,
    type Goal,
    type GoalSchedule,
} from "@notshekhar/loop-core";
import type { Args } from "../args";
import { parseOnceWhen } from "../interactive/time";
import { everyToCron, isValidCron } from "./schedule";
import { daemonInstall, daemonStatus, daemonUninstall } from "./daemon";
import { runGoal } from "./run";
import { runTick } from "./tick";

function describeSchedule(goal: Goal): string {
    if (goal.kind === "cron") return `cron ${goal.expr}`;
    if (goal.kind === "once") return `once ${new Date(goal.at).toLocaleString()}`;
    return "on demand";
}

function describeLastRun(goal: Goal): string {
    if (!goal.lastRun) return "never ran";
    return `${goal.lastRun.status} ${new Date(goal.lastRun.at).toLocaleString()}`;
}

function usage(): void {
    console.log(`Usage: ${PRODUCT_NAME} goals <command>

  list                          show goals with schedule and last-run status
  add <text> [options]          add a goal
      --cron "<expr>"           run on a cron schedule
      --every <30m|2h|1d>       run on an interval (sugar for --cron)
      --at "<when>"             run once (e.g. "18:30", "2h", "tomorrow 9:00")
      --cwd <dir>               directory the goal runs in (default: here)
      --model <provider/model>  model for scheduled runs
      --agent <name>            agent the goal runs under
  rm <id-prefix>                delete a goal
  run <id-prefix>               run a goal now (headless)
  tick                          run all due goals, then exit (what the daemon calls)
  daemon install|uninstall|status
                                manage the background scheduler (launchd/systemd)

Goals without a schedule run on demand: fire one with \`goals run <id>\`
(the TUI's /goal quick-add runs them immediately).`);
}

function findByPrefix(idPrefix: string): Goal | undefined {
    const matches = listGoals().filter((g) => g.id.startsWith(idPrefix.toUpperCase()) || g.id === idPrefix);
    if (matches.length > 1) {
        console.error(`ambiguous id prefix "${idPrefix}" (${matches.length} matches)`);
        return undefined;
    }
    return matches[0];
}

export async function cmdGoals(args: Args): Promise<void> {
    const [sub, ...rest] = args.positional;
    try {
        switch (sub) {
            case "list": {
                const goals = listGoals();
                if (goals.length === 0) {
                    console.log(`no goals — add one with: ${PRODUCT_NAME} goals add "<text>"`);
                    return;
                }
                for (const g of goals) {
                    const state = g.enabled ? "" : " (disabled)";
                    console.log(`${g.id.slice(0, 8)}  ${describeSchedule(g)}${state}  ${describeLastRun(g)}`);
                    console.log(`          ${g.text}  [${g.cwd}]`);
                }
                return;
            }
            case "add": {
                const text = rest.join(" ").trim();
                if (!text) {
                    console.error(`usage: ${PRODUCT_NAME} goals add "<text>" [--cron|--every|--at] [--cwd] [--model]`);
                    process.exitCode = 1;
                    return;
                }
                let schedule: GoalSchedule = { kind: "none" };
                const every = args.flags.every;
                const cron = args.flags.cron;
                const at = args.flags.at;
                if (typeof every === "string") {
                    const expr = everyToCron(every);
                    if (!expr) {
                        console.error(`cannot express --every ${every} as a schedule (try 30m, 2h, 1d)`);
                        process.exitCode = 1;
                        return;
                    }
                    schedule = { kind: "cron", expr };
                } else if (typeof cron === "string") {
                    if (!isValidCron(cron)) {
                        console.error(`invalid cron expression: ${cron}`);
                        process.exitCode = 1;
                        return;
                    }
                    schedule = { kind: "cron", expr: cron };
                } else if (typeof at === "string") {
                    const when = parseOnceWhen(at);
                    if (when === null) {
                        console.error(`cannot parse --at ${at} (try "18:30", "45m", "tomorrow 9:00")`);
                        process.exitCode = 1;
                        return;
                    }
                    schedule = { kind: "once", at: when };
                }
                const cwd = typeof args.flags.cwd === "string" ? args.flags.cwd : process.cwd();
                const model = typeof args.flags.model === "string" ? args.flags.model : undefined;
                const agent = typeof args.flags.agent === "string" ? args.flags.agent : undefined;
                const goal = addGoal(text, cwd, schedule, { model, agent });
                console.log(`added goal ${goal.id.slice(0, 8)} (${describeSchedule(goal)})`);
                return;
            }
            case "rm": {
                if (!rest[0]) {
                    console.error(`usage: ${PRODUCT_NAME} goals rm <id-prefix>`);
                    process.exitCode = 1;
                    return;
                }
                const goal = findByPrefix(rest[0]);
                if (!goal) {
                    console.error(`no goal matching "${rest[0]}"`);
                    process.exitCode = 1;
                    return;
                }
                deleteGoal(goal.id);
                console.log(`deleted: ${goal.text}`);
                return;
            }
            case "run": {
                const goal = rest[0] ? findByPrefix(rest[0]) : undefined;
                if (!goal) {
                    console.error(rest[0] ? `no goal matching "${rest[0]}"` : `usage: ${PRODUCT_NAME} goals run <id-prefix>`);
                    process.exitCode = 1;
                    return;
                }
                const result = await runGoal(goal);
                console.log(`${result.status}: ${result.summary}`);
                if (result.status === "error") process.exitCode = 1;
                return;
            }
            case "tick": {
                const ran = await runTick();
                if (ran > 0) console.log(`ran ${ran} goal${ran === 1 ? "" : "s"}`);
                return;
            }
            case "daemon": {
                const action = rest[0];
                if (action === "install") daemonInstall();
                else if (action === "uninstall") daemonUninstall();
                else if (action === "status") daemonStatus();
                else {
                    console.error(`usage: ${PRODUCT_NAME} goals daemon install|uninstall|status`);
                    process.exitCode = 1;
                }
                return;
            }
            default:
                usage();
                if (sub !== undefined && sub !== "help") process.exitCode = 1;
        }
    } finally {
        closeDb();
    }
}
