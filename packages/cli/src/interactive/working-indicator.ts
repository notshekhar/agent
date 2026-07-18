import chalk from "chalk";
import { Loader, type Component, type Container, type TUI } from "@notshekhar/loop-tui";

export interface WorkingIndicator {
    /** Show/update the spinner in the status slot (Esc-to-interrupt hint added). */
    showWorking(message?: string): void;
    /** Stop the spinner and restore the idle spacer so the editor never shifts. */
    hideWorking(): void;
}

// OSC 9;4 terminal tab progress bar (Ghostty, WezTerm, iTerm2 ≥ 3.6).
// Unknown OSC is ignored elsewhere; old iTerm2 shows it as a popup — gated below.
const OSC_PROGRESS_ON = "\x1b]9;4;1;-1\x07";
const OSC_PROGRESS_OFF = "\x1b]9;4;0;0\x07";
// Ghostty resets the indicator after ~15s of silence; re-send to keep alive.
const OSC_KEEPALIVE_MS = 5_000;

function supportsOscProgress(): boolean {
    // ponytail: env sniff, skip iTerm2 < 3.6 which misreads OSC 9 as a notification
    const term = process.env.TERM_PROGRAM;
    if (term === "ghostty" || term === "WezTerm") return true;
    if (term === "iTerm.app") {
        const [major = 0, minor = 0] = (process.env.TERM_PROGRAM_VERSION ?? "0.0").split(".").map(Number);
        return major > 3 || (major === 3 && minor >= 6);
    }
    return false;
}

function createTabProgress(): { start(): void; stop(): void } {
    const supported = supportsOscProgress();
    let keepalive: ReturnType<typeof setInterval> | null = null;
    return {
        start() {
            if (!supported || keepalive) return;
            process.stdout.write(OSC_PROGRESS_ON);
            keepalive = setInterval(() => process.stdout.write(OSC_PROGRESS_ON), OSC_KEEPALIVE_MS);
            keepalive.unref?.();
        },
        stop() {
            if (!supported) return;
            if (keepalive) {
                clearInterval(keepalive);
                keepalive = null;
                process.stdout.write(OSC_PROGRESS_OFF);
            }
        },
    };
}

/**
 * Drives the fixed-height status slot above the editor: a Loader while a turn
 * (or hook) is working, the idle spacer otherwise. The slot keeps a constant
 * height so the editor/status line block never jumps a row.
 */
export function createWorkingIndicator(
    tui: TUI,
    statusContainer: Container,
    statusIdleSpacer: Component,
): WorkingIndicator {
    let workingLoader: Loader | null = null;
    const tabProgress = createTabProgress();

    function showWorking(message = "Generating…"): void {
        const fullMsg = `${message} ${chalk.dim("(Esc to interrupt)")}`;
        if (workingLoader) {
            workingLoader.setMessage(fullMsg);
            return;
        }
        workingLoader = new Loader(
            tui,
            (s) => chalk.cyan(s),
            (s) => chalk.dim(s),
            fullMsg,
        );
        statusContainer.clear();
        statusContainer.addChild(workingLoader);
        workingLoader.start();
        tabProgress.start();
        tui.requestRender();
    }

    function hideWorking(): void {
        tabProgress.stop();
        if (!workingLoader) return;
        workingLoader.stop();
        statusContainer.clear();
        statusContainer.addChild(statusIdleSpacer);
        workingLoader = null;
        tui.requestRender();
    }

    return { showWorking, hideWorking };
}
