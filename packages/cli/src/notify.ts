import { spawn } from "node:child_process";
import { envName } from "@notshekhar/loop-core";

/**
 * Fire-and-forget desktop notification: osascript on macOS, notify-send on
 * Linux, a PowerShell toast on Windows, silently nothing elsewhere. Title and
 * body always travel out-of-band (argv on unix, environment on Windows) —
 * never interpolated into the script text, so goal text can't break out of
 * it. Failures are swallowed: a missing notifier must never fail the caller.
 */

const TITLE_ENV = envName("NOTIFY_TITLE");
const BODY_ENV = envName("NOTIFY_BODY");

/** Windows toast via the WinRT API; reads title/body from the environment.
 * The PowerShell AppId keeps toasts working without registering our own. */
const TOAST_PS = [
    "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$text = $xml.GetElementsByTagName('text')",
    `$null = $text.Item(0).AppendChild($xml.CreateTextNode($env:${TITLE_ENV}))`,
    `$null = $text.Item(1).AppendChild($xml.CreateTextNode($env:${BODY_ENV}))`,
    "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
].join("; ");

interface NotifyCommand {
    cmd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
}

/** Platform-specific spawn spec, or null where notifications aren't supported. */
export function notifyCommand(title: string, body: string): NotifyCommand | null {
    switch (process.platform) {
        case "darwin":
            return {
                cmd: "osascript",
                args: [
                    "-e",
                    "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run",
                    title,
                    body,
                ],
            };
        case "linux":
            return { cmd: "notify-send", args: [title, body] };
        case "win32":
            return {
                cmd: "powershell",
                args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", TOAST_PS],
                env: { ...process.env, [TITLE_ENV]: title, [BODY_ENV]: body },
            };
        default:
            return null;
    }
}

export function notify(title: string, body: string): void {
    try {
        const spec = notifyCommand(title, body);
        if (!spec) return;
        const child = spawn(spec.cmd, spec.args, { stdio: "ignore", detached: true, env: spec.env });
        child.on("error", () => {});
        child.unref();
    } catch {
        // Notification is best-effort by definition.
    }
}
