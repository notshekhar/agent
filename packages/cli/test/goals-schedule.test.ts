import { describe, expect, test } from "bun:test";
import type { Goal } from "@notshekhar/loop-core";
import { dueGoals, everyToCron, isValidCron, nextCronRun } from "../src/goals/schedule";
import { renderPlist, renderSystemdUnits, renderTickVbs, schtasksCreateArgs } from "../src/goals/daemon";

describe("nextCronRun", () => {
    test("computes the next firing after a timestamp", () => {
        const after = new Date("2026-07-06T10:30:00").getTime();
        const next = nextCronRun("0 * * * *", after); // top of every hour
        expect(next).toBe(new Date("2026-07-06T11:00:00").getTime());
    });

    test("returns null for garbage expressions", () => {
        expect(nextCronRun("not a cron", Date.now())).toBeNull();
    });
});

describe("everyToCron", () => {
    test("minutes, hours, days", () => {
        expect(everyToCron("30m")).toBe("*/30 * * * *");
        expect(everyToCron("45")).toBe("*/45 * * * *");
        expect(everyToCron("2h")).toBe("0 */2 * * *");
        expect(everyToCron("120m")).toBe("0 */2 * * *");
        expect(everyToCron("1d")).toBe("0 0 */1 * *");
    });

    test("rejects what cron can't express", () => {
        expect(everyToCron("90m")).toBeNull();
        expect(everyToCron("0m")).toBeNull();
        expect(everyToCron("soon")).toBeNull();
    });

    test("sugar output is valid cron", () => {
        for (const spec of ["1m", "30m", "2h", "12h", "1d", "7d"]) {
            const expr = everyToCron(spec);
            expect(expr).not.toBeNull();
            expect(isValidCron(expr!)).toBe(true);
        }
    });
});

describe("dueGoals", () => {
    test("filters with real croner math", () => {
        const now = Date.now();
        const mk = (
            over: Partial<Goal> & ({ kind: "none" } | { kind: "once"; at: number } | { kind: "cron"; expr: string }),
        ): Goal => ({ id: "g", text: "t", cwd: "/", enabled: true, createdAt: now - 10 * 60_000, ...over }) as Goal;
        const due = dueGoals(
            [
                mk({ id: "standing", kind: "none" }),
                mk({ id: "past-once", kind: "once", at: now - 1000 }),
                mk({ id: "future-once", kind: "once", at: now + 60_000 }),
                mk({ id: "every-min", kind: "cron", expr: "* * * * *" }), // due: created 10m ago, never ran
                mk({
                    id: "just-ran",
                    kind: "cron",
                    expr: "0 0 1 1 *",
                    lastRun: { at: now - 1000, sessionId: "s", status: "ok", summary: null },
                }),
            ],
            now,
        );
        expect(due.map((g) => g.id)).toEqual(["past-once", "every-min"]);
    });
});

describe("daemon unit rendering", () => {
    test("plist carries argv, 60s interval, and escaped strings", () => {
        const plist = renderPlist(["/usr/local/bin/loop", "goals", "tick"], "/tmp/a & b.log");
        expect(plist).toContain("<string>/usr/local/bin/loop</string>");
        expect(plist).toContain("<string>goals</string>");
        expect(plist).toContain("<string>tick</string>");
        expect(plist).toContain("<key>StartInterval</key>");
        expect(plist).toContain("<integer>60</integer>");
        expect(plist).toContain("/tmp/a &amp; b.log");
    });

    test("systemd units: oneshot service + minutely timer", () => {
        const { service, timer } = renderSystemdUnits(["/usr/bin/loop", "goals", "tick"]);
        expect(service).toContain("Type=oneshot");
        expect(service).toContain("ExecStart=/usr/bin/loop goals tick");
        expect(timer).toContain("OnCalendar=*:0/1");
    });

    test("windows vbs launcher: hidden window, quoted paths, log redirect", () => {
        const vbs = renderTickVbs(["C:\\Program Files\\loop\\loop.exe", "goals", "tick"], "C:\\Users\\a b\\goals.log");
        // WScript string literal: embedded quotes double, window style 0, no wait.
        expect(vbs).toContain('CreateObject("WScript.Shell").Run "cmd /c ""');
        expect(vbs).toContain('""C:\\Program Files\\loop\\loop.exe"" goals tick');
        expect(vbs).toContain('>> ""C:\\Users\\a b\\goals.log"" 2>&1');
        expect(vbs.trimEnd().endsWith(", 0, False")).toBe(true);
    });

    test("schtasks args: minutely task pointing wscript at the launcher", () => {
        const args = schtasksCreateArgs("C:\\Users\\a\\.loop\\agent\\goals-tick.vbs");
        expect(args).toEqual([
            "/Create",
            "/F",
            "/SC",
            "MINUTE",
            "/MO",
            "1",
            "/TN",
            "loop-goals",
            "/TR",
            'wscript.exe "C:\\Users\\a\\.loop\\agent\\goals-tick.vbs"',
        ]);
    });
});
