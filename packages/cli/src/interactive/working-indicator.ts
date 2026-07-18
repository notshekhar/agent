import chalk from "chalk";
import { Loader, type Component, type Container, type TUI } from "@notshekhar/loop-tui";

export interface WorkingIndicator {
    /** Show/update the spinner in the status slot (Esc-to-interrupt hint added). */
    showWorking(message?: string): void;
    /** Stop the spinner and restore the idle spacer so the editor never shifts. */
    hideWorking(): void;
}

// OSC 9;4 terminal tab progress (Ghostty, WezTerm, iTerm2 ≥ 3.6). The writes
// live in Terminal.setProgress; this gate exists because old iTerm2 renders
// unknown OSC 9 as a notification popup instead of ignoring it.
function supportsOscProgress(): boolean {
    const term = process.env.TERM_PROGRAM;
    if (term === "ghostty" || term === "WezTerm") return true;
    if (term === "iTerm.app") {
        const [major = 0, minor = 0] = (process.env.TERM_PROGRAM_VERSION ?? "0.0").split(".").map(Number);
        return major > 3 || (major === 3 && minor >= 6);
    }
    return false;
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
    const oscProgress = supportsOscProgress();

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
        if (oscProgress) tui.terminal.setProgress(true);
        tui.requestRender();
    }

    function hideWorking(): void {
        if (oscProgress) tui.terminal.setProgress(false);
        if (!workingLoader) return;
        workingLoader.stop();
        statusContainer.clear();
        statusContainer.addChild(statusIdleSpacer);
        workingLoader = null;
        tui.requestRender();
    }

    return { showWorking, hideWorking };
}
