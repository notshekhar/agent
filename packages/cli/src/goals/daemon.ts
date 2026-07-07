/**
 * Goals daemon = the OS scheduler firing `<product> goals tick` every minute:
 * a launchd user agent on macOS, a systemd user timer on Linux, a Task
 * Scheduler job on Windows. Tick-based on purpose — nothing long-lived to
 * babysit, reboots and crashes cost at most one beat, and single-instancing
 * lives in the tick's pid lock.
 *
 * Windows runs the tick through a generated .vbs launcher (window style 0):
 * schtasks starting a console app directly would flash a console window on
 * the user's desktop every minute.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getConfigDir, PRODUCT_NAME } from "@notshekhar/loop-core";

const LAUNCHD_LABEL = `com.${PRODUCT_NAME}.goals`;
const SYSTEMD_NAME = `${PRODUCT_NAME}-goals`;
const WINDOWS_TASK_NAME = `${PRODUCT_NAME}-goals`;

/** How the daemon must invoke the tick: the compiled binary directly, or `bun <entry>` in dev. */
function tickArgv(): string[] {
    const exe = process.execPath;
    if (basename(exe).toLowerCase().startsWith("bun")) {
        const entry = Bun.main ?? process.argv[1] ?? "";
        return [exe, entry, "goals", "tick"];
    }
    return [exe, "goals", "tick"];
}

function logPath(): string {
    const dir = join(getConfigDir(), "agent");
    mkdirSync(dir, { recursive: true });
    return join(dir, "goals.log");
}

function plistPath(): string {
    return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function systemdDir(): string {
    return join(homedir(), ".config", "systemd", "user");
}

function vbsLauncherPath(): string {
    const dir = join(getConfigDir(), "agent");
    mkdirSync(dir, { recursive: true });
    return join(dir, "goals-tick.vbs");
}

const xmlEscape = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** cmd.exe-style quoting: wrap in double quotes when the value needs it. */
const winQuote = (s: string): string => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** VBScript string literal — inner quotes double. */
const vbsQuote = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * The Windows launcher: WScript.Shell.Run with window style 0 keeps the
 * minutely tick invisible; cmd /c handles the log redirection schtasks can't.
 */
export function renderTickVbs(argv: string[], log: string): string {
    const command = `cmd /c "${argv.map(winQuote).join(" ")} >> ${winQuote(log)} 2>&1"`;
    return `CreateObject("WScript.Shell").Run ${vbsQuote(command)}, 0, False\n`;
}

/** schtasks argv for the minutely tick task — split out for tests. */
export function schtasksCreateArgs(vbsPath: string): string[] {
    return ["/Create", "/F", "/SC", "MINUTE", "/MO", "1", "/TN", WINDOWS_TASK_NAME, "/TR", `wscript.exe "${vbsPath}"`];
}

export function renderPlist(argv: string[], log: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argv.map((a) => `        <string>${xmlEscape(a)}</string>`).join("\n")}
    </array>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnits(argv: string[]): { service: string; timer: string } {
    const service = `[Unit]
Description=${PRODUCT_NAME} goals tick

[Service]
Type=oneshot
ExecStart=${argv.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}
`;
    const timer = `[Unit]
Description=${PRODUCT_NAME} goals scheduler

[Timer]
OnCalendar=*:0/1
Persistent=false

[Install]
WantedBy=timers.target
`;
    return { service, timer };
}

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
    const res = spawnSync(cmd, args, { encoding: "utf8" });
    return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

/** Cheap installed-probe for UI hints — file presence only, no process spawn.
 * install/uninstall keep these files in lockstep with the OS scheduler entry. */
export function isDaemonInstalled(): boolean {
    if (process.platform === "darwin") return existsSync(plistPath());
    if (process.platform === "linux") return existsSync(join(systemdDir(), `${SYSTEMD_NAME}.timer`));
    if (process.platform === "win32") return existsSync(vbsLauncherPath());
    return false;
}

/** Install the OS scheduler entry. Returns the human-readable result (the
 * caller decides where it goes: stdout for the CLI, history for the TUI). */
export function daemonInstall(): string {
    const argv = tickArgv();
    if (process.platform === "darwin") {
        const plist = plistPath();
        mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
        // Re-bootstrap cleanly if a previous install is loaded.
        sh("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
        writeFileSync(plist, renderPlist(argv, logPath()));
        const boot = sh("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, plist]);
        if (!boot.ok) {
            // Older macOS: bootstrap unavailable — fall back to load -w.
            const load = sh("launchctl", ["load", "-w", plist]);
            if (!load.ok) throw new Error(`launchctl failed: ${boot.out || load.out}`);
        }
        return `installed launchd agent ${LAUNCHD_LABEL} (ticks every 60s)\nplist: ${plist}\nlog: ${logPath()}`;
    }
    if (process.platform === "linux") {
        const dir = systemdDir();
        mkdirSync(dir, { recursive: true });
        const units = renderSystemdUnits(argv);
        writeFileSync(join(dir, `${SYSTEMD_NAME}.service`), units.service);
        writeFileSync(join(dir, `${SYSTEMD_NAME}.timer`), units.timer);
        sh("systemctl", ["--user", "daemon-reload"]);
        const enable = sh("systemctl", ["--user", "enable", "--now", `${SYSTEMD_NAME}.timer`]);
        if (!enable.ok) throw new Error(`systemctl failed: ${enable.out}`);
        return `installed systemd user timer ${SYSTEMD_NAME}.timer (ticks every minute)\nlog: journalctl --user -u ${SYSTEMD_NAME}`;
    }
    if (process.platform === "win32") {
        const vbs = vbsLauncherPath();
        writeFileSync(vbs, renderTickVbs(argv, logPath()));
        const create = sh("schtasks", schtasksCreateArgs(vbs));
        if (!create.ok) {
            rmSync(vbs, { force: true }); // keep the installed-probe truthful
            throw new Error(`schtasks failed: ${create.out}`);
        }
        return `installed Task Scheduler job ${WINDOWS_TASK_NAME} (ticks every minute)\nlauncher: ${vbs}\nlog: ${logPath()}`;
    }
    throw new Error(`goals daemon install is not supported on ${process.platform}`);
}

export function daemonUninstall(): string {
    if (process.platform === "darwin") {
        sh("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
        rmSync(plistPath(), { force: true });
        return `removed launchd agent ${LAUNCHD_LABEL}`;
    }
    if (process.platform === "linux") {
        sh("systemctl", ["--user", "disable", "--now", `${SYSTEMD_NAME}.timer`]);
        rmSync(join(systemdDir(), `${SYSTEMD_NAME}.service`), { force: true });
        rmSync(join(systemdDir(), `${SYSTEMD_NAME}.timer`), { force: true });
        sh("systemctl", ["--user", "daemon-reload"]);
        return `removed systemd user timer ${SYSTEMD_NAME}.timer`;
    }
    if (process.platform === "win32") {
        sh("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
        rmSync(vbsLauncherPath(), { force: true });
        return `removed Task Scheduler job ${WINDOWS_TASK_NAME}`;
    }
    throw new Error(`goals daemon is not supported on ${process.platform}`);
}

export function daemonStatus(): string {
    if (process.platform === "darwin") {
        const installed = existsSync(plistPath());
        const print = sh("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
        return `${installed ? `plist: ${plistPath()}` : "not installed"}\n${print.ok ? "launchd: loaded" : "launchd: not loaded"}`;
    }
    if (process.platform === "linux") {
        const status = sh("systemctl", ["--user", "is-active", `${SYSTEMD_NAME}.timer`]);
        return `systemd timer: ${status.out || "not installed"}`;
    }
    if (process.platform === "win32") {
        const query = sh("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME]);
        return query.ok ? `Task Scheduler job ${WINDOWS_TASK_NAME}: installed` : "not installed";
    }
    return `goals daemon is not supported on ${process.platform}`;
}
