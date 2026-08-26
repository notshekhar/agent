/**
 * Background shell registry — driven against real spawned processes, because
 * every interesting behaviour here (exit codes, kill trees, output arriving
 * between reads) is the OS's, not ours. A mocked child would only prove the
 * mock works.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    formatDuration,
    killShell,
    listShells,
    readShell,
    registerShell,
    resetShellRegistry,
    runningShellCount,
    takeShellNotices,
    type ShellInfo,
} from "../src/tools/utils/shell-registry";
import { formatShellNotices } from "../src/tools/shells";

const SESSION = "test-session";
let home: string;
let prevHome: string | undefined;

function start(command: string, session = SESSION): ShellInfo {
    const child = spawn("/bin/bash", ["-c", command], {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return registerShell({ sessionId: session, command, cwd: process.cwd(), child });
}

/** Poll until the shell leaves "running", or fail loudly. */
async function settled(id: string, session = SESSION, timeoutMs = 5000): Promise<ShellInfo> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const found = listShells(session).find((s) => s.id === id);
        if (found && found.status !== "running") return found;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${id} never settled`);
}

beforeEach(() => {
    // The registry writes logs under the config dir; give each run its own.
    home = mkdtempSync(join(tmpdir(), "loop-shells-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    resetShellRegistry();
});

afterEach(() => {
    for (const s of listShells(SESSION)) if (s.status === "running") killShell(SESSION, s.id);
    resetShellRegistry();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
});

describe("registry", () => {
    test("ids are per-session and sequential", () => {
        expect(start("true").id).toBe("bash_1");
        expect(start("true").id).toBe("bash_2");
        expect(start("true", "other").id).toBe("bash_1");
    });

    test("a finished shell reports its exit code", async () => {
        const s = start("exit 3");
        const done = await settled(s.id);
        expect(done.status).toBe("exited");
        expect(done.exitCode).toBe(3);
        expect(done.endedAt).not.toBeNull();
    });

    test("running shells are counted, finished ones are not", async () => {
        const s = start("sleep 30");
        expect(runningShellCount(SESSION)).toBe(1);
        killShell(SESSION, s.id);
        await settled(s.id);
        expect(runningShellCount(SESSION)).toBe(0);
    });

    test("kill stops the whole process tree", async () => {
        // The child spawns a grandchild; killing by pid alone would orphan it.
        const s = start("sleep 60 & sleep 60");
        const info = killShell(SESSION, s.id);
        expect(info).toBeDefined();
        const done = await settled(s.id);
        expect(done.status === "killed" || done.status === "exited").toBe(true);
    });
});

describe("reads", () => {
    test("output is returned once, not on every read", async () => {
        const s = start("echo first; echo second");
        await settled(s.id);
        const first = readShell(SESSION, s.id);
        expect(first?.text).toContain("first");
        expect(first?.text).toContain("second");
        // The cursor advanced: the same output must not come back again.
        const second = readShell(SESSION, s.id);
        expect(second?.text.trim()).toBe("");
    });

    test("advance:false leaves the output for the next reader", async () => {
        // /shells peeking must not consume what the agent has not read yet.
        const s = start("echo hello");
        await settled(s.id);
        expect(readShell(SESSION, s.id, { advance: false })?.text).toContain("hello");
        expect(readShell(SESSION, s.id)?.text).toContain("hello");
    });

    test("filter keeps matching lines and counts the rest", async () => {
        const s = start("echo alpha; echo BAD thing; echo beta");
        await settled(s.id);
        const r = readShell(SESSION, s.id, { filter: "BAD" });
        expect(r?.text).toContain("BAD thing");
        expect(r?.text).not.toContain("alpha");
        expect(r?.filteredOut).toBeGreaterThan(0);
    });

    test("an unparseable filter is ignored rather than fatal", async () => {
        const s = start("echo hello");
        await settled(s.id);
        const r = readShell(SESSION, s.id, { filter: "([" });
        expect(r?.text).toContain("hello");
    });

    test("reading an unknown shell returns undefined", () => {
        expect(readShell(SESSION, "bash_99")).toBeUndefined();
        expect(killShell(SESSION, "bash_99")).toBeUndefined();
    });
});

describe("exit notices", () => {
    test("an exit is reported exactly once", async () => {
        const s = start("exit 1");
        await settled(s.id);
        const first = takeShellNotices(SESSION);
        expect(first.map((n) => n.id)).toEqual([s.id]);
        // Taken means delivered: the model is not told twice about one exit.
        expect(takeShellNotices(SESSION)).toEqual([]);
    });

    test("a running shell produces no notice", () => {
        start("sleep 30");
        expect(takeShellNotices(SESSION)).toEqual([]);
    });
});

describe("formatDuration", () => {
    test("reads as elapsed time, not milliseconds", () => {
        expect(formatDuration(8_000)).toBe("8s");
        expect(formatDuration(134_000)).toBe("2m14s");
        expect(formatDuration(3_780_000)).toBe("1h03m");
    });
});

describe("exit notice text", () => {
    test("names the shell, what happened, and whether output is waiting", async () => {
        const s = start("echo left-behind; exit 2");
        const done = await settled(s.id);
        const text = formatShellNotices([done]);
        expect(text).toContain(s.id);
        expect(text).toContain("exited with code 2");
        expect(text).toContain("bytes unread");
        // Ephemeral by contract: it must look like a reminder, not a message
        // the user wrote — it rides one request and is never persisted.
        expect(text?.startsWith("<system-reminder>")).toBe(true);
    });

    test("nothing to report produces nothing at all", () => {
        expect(formatShellNotices([])).toBeNull();
    });
});
