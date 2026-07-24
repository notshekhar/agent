/**
 * Text clipboard writes via the platform's own tool — pbcopy (macOS),
 * clip (Windows), wl-copy/xclip/xsel tried in order (Linux). spawn()
 * failures arrive as async 'error' events (a try/catch around spawn never
 * sees ENOENT, it crashes the process instead), so the outcome is reported
 * through a callback — callers must not claim "copied" before it lands.
 */
import { spawn, spawnSync } from "node:child_process";

const COMMANDS: string[][] =
    process.platform === "darwin"
        ? [["pbcopy"]]
        : process.platform === "win32"
          ? [["clip"]]
          : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];

/** Read commands, same platform order as {@link COMMANDS}. */
const READ_COMMANDS: string[][] =
    process.platform === "darwin"
        ? [["pbpaste"]]
        : process.platform === "win32"
          ? [["powershell", "-NoProfile", "-Command", "Get-Clipboard"]]
          : [
                ["wl-paste", "--no-newline"],
                ["xclip", "-selection", "clipboard", "-o"],
                ["xsel", "--clipboard"],
            ];

/**
 * The clipboard's text flavour, or null when it holds none (an image-only
 * clipboard reads as empty). Synchronous: this runs on a keystroke, and the
 * paste has to land in the editor before the next render.
 */
export function readClipboardText(): string | null {
    for (const [cmd, ...args] of READ_COMMANDS) {
        const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        if (res.error || res.status !== 0) continue;
        const text = res.stdout ?? "";
        return text === "" ? null : text;
    }
    return null;
}

/** Write `text` to the system clipboard; onResult(true) once a tool took it. */
export function copyToClipboard(text: string, onResult: (ok: boolean) => void): void {
    const tryNext = (i: number): void => {
        if (i >= COMMANDS.length) return onResult(false);
        const [cmd, ...args] = COMMANDS[i];
        const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
        // 'error' (ENOENT) and 'close' can both fire for one attempt — settle once.
        let settled = false;
        const settle = (ok: boolean): void => {
            if (settled) return;
            settled = true;
            if (ok) onResult(true);
            else tryNext(i + 1);
        };
        child.on("error", () => settle(false));
        child.on("close", (code) => settle(code === 0));
        child.stdin.on("error", () => {}); // EPIPE when the tool dies mid-write
        child.stdin.end(text);
    };
    tryNext(0);
}
