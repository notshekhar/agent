<!-- title: Automation -->
<!-- order: 6 -->
<!-- blurb: Background tasks on a schedule, goal mode, reminders, and the OS-level daemon that runs them when loop is closed. -->

Two different things share a similar name, so start here:

- **Background tasks** (`/background`) run **detached from your session**, headless, tied to a directory — on demand, once, or on a cron schedule. They can fire when loop isn't even open.
- **Goal mode** (`/goal`) drives **the session you're in** autonomously until a verifier agrees the objective is met.

## Background tasks

`/background` in the TUI is the manager: add, edit, run now, or hand a task to the scheduler.

Three schedule kinds:

| Kind          | Means                                                       |
| ------------- | ----------------------------------------------------------- |
| **on demand** | No schedule. Runs when you say so.                          |
| **once**      | A single future run — `10m`, `18:30`, `2026-06-15 09:00`    |
| **cron**      | A recurring expression — `0 9 * * 1-5` is weekdays at 09:00 |

Each task carries its own text, schedule, working directory, model, and agent. You can run one immediately as a headless background run, or reopen its last run as a normal session to see what it did.

### From the shell

`loop background` (alias `loop goals`) does everything the TUI does:

```
loop background list
loop background add "check for dependency updates" --cron "0 9 * * 1"
loop background add "summarize today's commits" --every 1d --cwd ~/code/api
loop background add "run the smoke tests" --at "18:30"
loop background run A1B2
loop background rm A1B2
loop background tick
```

Options for `add`:

| Flag                       | What                                       |
| -------------------------- | ------------------------------------------ |
| `--cron "<expr>"`          | Cron schedule                              |
| `--every <30m\|2h\|1d>`    | Interval — sugar over `--cron`             |
| `--at "<when>"`            | Run once (`18:30`, `2h`, `tomorrow 9:00`)  |
| `--cwd <dir>`              | Directory the task runs in (default: here) |
| `--model <provider/model>` | Model for scheduled runs                   |
| `--agent <name>`           | Agent the task runs under                  |

Ids are shown as short prefixes; any unambiguous prefix works for `run` and `rm`.

`tick` runs everything that's currently due and exits — that's what the scheduler calls, and it's what you'd wire into your own cron if you'd rather not install the daemon.

## The scheduler daemon

Scheduled tasks run on an **OS timer** — launchd on macOS, systemd on Linux, Task Scheduler on Windows — so they fire whether or not loop is running.

```
loop background daemon install
loop background daemon status
loop background daemon uninstall
```

Or `/daemon` in the TUI. Without it, scheduled tasks only run when something calls `tick`.

## Goal mode

```
/goal ship the auth refactor
```

Goal mode runs the current session on a loop until the objective is actually done:

1. **Planner** writes a frozen plan. No plan, no goal.
2. **Turn** runs with the goal rules injected.
3. **Continue** — unchecked plan boxes become the next directive.
4. **Verifier** does a read-only audit of the workspace. A clean verdict ends the goal; a refutation feeds the gaps back into the next turn.

The verifier is adversarial on purpose — it's looking for reasons the work _isn't_ done, which is what stops an agent from declaring victory on a half-finished refactor.

`Esc` pauses. `/goal resume` picks it back up. Step caps and detected stalls **auto-pause rather than burning tokens forever**.

## Reminders and timers

- `/timer 25m` — a timer that surfaces in the TUI
- `/reminder` — one-off nudges tied to the project
- `/recap` — what happened recently in this directory

These are lighter than background tasks: they notify, they don't run the agent.

## Composing it

A realistic setup:

```
loop background daemon install
loop background add "review open PRs and flag anything risky" --cron "0 9 * * 1-5" --cwd ~/code/api --model anthropic/claude-sonnet-4-6
```

Pair that with the [Telegram bridge](telegram.html) and the results land on your phone.
