/**
 * /shells — the user's half of background shells. The agent reaches them
 * through the `shells` tool; this is the same registry from the other side, so
 * a process the agent started (or forgot) can always be inspected and killed
 * by hand.
 *
 * `/shells` lists · `/shells run <cmd>` starts one · `/shells kill <id>` or
 * `/shells kill all` stops them · `/shells <id>` prints the tail of one
 * shell's log into the transcript.
 *
 * `run` is the user's own hand on the keyboard, so it skips the denylist and
 * the approval prompt — those exist to gate what the MODEL runs, and a person
 * typing a command into their own shell has already approved it. It lands in
 * the same registry, so a server the user starts is one the agent can read.
 */
import { spawn } from "node:child_process";
import {
    formatDuration,
    getShellConfig,
    getShellEnv,
    killSessionShells,
    killShell,
    listShells,
    readShell,
    registerShell,
    runningShellCount,
    MAX_BACKGROUND_SHELLS,
    type CommandContext,
    type ShellInfo,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { dim, heading } from "../ui/text";

type ShellsHandlers = Pick<CommandContext, "manageShells">;

function statusText(s: ShellInfo): string {
    if (s.status === "running") return `running ${formatDuration(Date.now() - s.startedAt)}`;
    if (s.status === "killed") return "killed";
    if (s.status === "failed") return "failed to start";
    return s.exitCode === 0 ? "exited 0" : `exited ${s.exitCode ?? "?"}`;
}

export function createShellsHandlers(state: AppState, deps: AppDeps): ShellsHandlers {
    const { tui, history, shellsPanel } = deps;

    const refresh = () => {
        shellsPanel.setShells(listShells(state.session?.id));
        tui.requestRender();
    };

    return {
        manageShells(args: string) {
            const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
            const shells = listShells(state.session?.id);

            if (!verb) {
                if (shells.length === 0) {
                    history.addSystem(
                        dim("No background shells. /shells run <cmd> starts one, or bash run_in_background does."),
                    );
                    tui.requestRender();
                    return;
                }
                const lines = [heading("Background shells")];
                for (const s of shells) {
                    lines.push(`  ${s.id}  ${statusText(s)}  ${s.command.split("\n")[0]}`);
                    if (s.logPath) lines.push(dim(`        ${s.logPath}`));
                }
                lines.push(
                    dim("  /shells run <cmd> · /shells kill <id> · /shells kill all · /shells <id> for its output"),
                );
                history.addSystem(lines.join("\n"));
                tui.requestRender();
                return;
            }

            if (verb === "run") {
                const command = args.trim().slice(verb.length).trim();
                if (!command) {
                    history.addError("Usage: /shells run <command>");
                    tui.requestRender();
                    return;
                }
                if (runningShellCount(state.session?.id) >= MAX_BACKGROUND_SHELLS) {
                    history.addError(`Already running ${MAX_BACKGROUND_SHELLS} shells — kill one first.`);
                    tui.requestRender();
                    return;
                }
                try {
                    const { shell, args: shellArgs } = getShellConfig();
                    const child = spawn(shell, [...shellArgs, command], {
                        cwd: state.cwd,
                        detached: process.platform !== "win32",
                        env: getShellEnv(),
                        stdio: ["ignore", "pipe", "pipe"],
                    });
                    const info = registerShell({ sessionId: state.session?.id, command, cwd: state.cwd, child });
                    history.addSystem(`${info.id} started (pid ${info.pid ?? "?"}) · ${command}`);
                } catch (err) {
                    history.addError(`Could not start: ${(err as Error).message}`);
                }
                refresh();
                return;
            }

            if (verb === "kill") {
                const target = rest[0];
                if (!target) {
                    history.addError("Usage: /shells kill <id> · /shells kill all");
                    tui.requestRender();
                    return;
                }
                if (target === "all") {
                    const n = killSessionShells(state.session?.id);
                    history.addSystem(n > 0 ? `Killed ${n} shell${n === 1 ? "" : "s"}.` : dim("Nothing was running."));
                    refresh();
                    return;
                }
                const info = killShell(state.session?.id, target);
                if (!info) history.addError(`No shell ${target}.`);
                else history.addSystem(`${info.id} killed.`);
                refresh();
                return;
            }

            // Anything else is treated as a shell id: show its recent output.
            // `advance: false` deliberately — reading along with the agent must
            // not consume output the agent has not seen yet.
            const result = readShell(state.session?.id, verb, { advance: false });
            if (!result) {
                history.addError(`No shell ${verb}. Try /shells.`);
                tui.requestRender();
                return;
            }
            const body = result.text.trim();
            history.addSystem(
                [
                    heading(`${result.info.id} — ${statusText(result.info)}`),
                    dim(result.info.command.split("\n")[0]),
                    "",
                    body || dim("(no output yet)"),
                ].join("\n"),
            );
            tui.requestRender();
        },
    };
}
