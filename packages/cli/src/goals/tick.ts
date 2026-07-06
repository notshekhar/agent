/**
 * One scheduler heartbeat: run every due scheduled goal, then exit. The
 * daemon (launchd/systemd timer) invokes this every minute; running it by
 * hand is the same thing. Overlap protection is a pid file with a liveness
 * check (the rpc daemon's pattern) — a tick that finds a live predecessor
 * exits 0 quietly, so a long goal run just absorbs the next few beats.
 *
 * Catch-up policy: a due goal runs at most once per tick, no backfill of
 * missed windows. "once" goals stay as disabled rows so their last run
 * remains visible in the manager.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDb, getConfigDir, listGoals, updateGoal } from "@notshekhar/loop-core";
import { dueGoals } from "./schedule";
import { runGoal } from "./run";

function tickPidPath(): string {
    const dir = join(getConfigDir(), "agent");
    mkdirSync(dir, { recursive: true });
    return join(dir, "goals-tick.pid");
}

/** Pid from the lock file if that process is still alive, else null. */
function liveTickPid(pidPath: string): number | null {
    if (!existsSync(pidPath)) return null;
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        process.kill(pid, 0);
        return pid;
    } catch {
        return null;
    }
}

export async function runTick(opts: { onLog?: (line: string) => void } = {}): Promise<number> {
    const log = opts.onLog ?? ((line: string) => process.stderr.write(`${line}\n`));
    const pidPath = tickPidPath();
    if (liveTickPid(pidPath) !== null) return 0; // previous tick still running
    writeFileSync(pidPath, String(process.pid));
    const releaseLock = () => {
        try {
            if (liveTickPid(pidPath) === process.pid) unlinkSync(pidPath);
        } catch {
            // Stale lock self-heals via the liveness check.
        }
    };
    process.on("SIGINT", () => {
        releaseLock();
        process.exit(130);
    });
    process.on("SIGTERM", () => {
        releaseLock();
        process.exit(143);
    });

    let ran = 0;
    try {
        const due = dueGoals(listGoals(), Date.now());
        for (const goal of due) {
            log(`running goal: ${goal.text}`);
            try {
                const result = await runGoal(goal);
                log(`goal ${result.status}: ${goal.text}`);
            } catch (err) {
                log(`goal crashed: ${goal.text}: ${String((err as Error)?.message ?? err)}`);
            }
            // A fired one-shot must not fire again; the disabled row keeps its
            // last-run status visible in the manager.
            if (goal.kind === "once") updateGoal(goal.id, { enabled: false });
            ran++;
        }
    } finally {
        releaseLock();
        closeDb();
    }
    return ran;
}
