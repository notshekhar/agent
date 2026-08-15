import { describe, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { ProcessTerminal } from "../src/terminal";

// pop kitty keyboard protocol · disable modifyOtherKeys · disable bracketed
// paste · show cursor. Left enabled, these make the shell echo raw escapes
// (\x1b[27;5;13~) on the next keypress after an uncaught-signal exit.
const RESET = "\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b]111\x07\x1b]110\x07\x1b[?25h";

function withTTY<T>(isTTY: boolean, fn: () => T): T {
    const original = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
    try {
        return fn();
    } finally {
        Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true });
    }
}

describe("terminal teardown", () => {
    test("stop() disables mouse reporting", () => {
        // stop() removes the exit safety net BEFORE tearing down, so whatever
        // it fails to reset here is not reset by anything else on a clean quit.
        // Mouse reporting used to ride out on nav mode always turning it off
        // itself; a prompt pinned for the whole session holds it to teardown,
        // and a terminal left reporting answers every scroll and click on the
        // shell prompt with raw `\x1b[<64;20;5M`.
        const term = new ProcessTerminal();
        const write = spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
            term.stop();
            const written = write.mock.calls.map((c) => String(c[0])).join("");
            expect(written).toContain("\x1b[?1000l");
            expect(written).toContain("\x1b[?1006l");
        } finally {
            write.mockRestore();
        }
    });
});

describe("terminal exit safety net", () => {
    test("writes the reset sequence to fd 1 when stdout is a TTY", () => {
        const term = new ProcessTerminal() as unknown as { resetKeyboardModesSync(): void };
        const writeSync = spyOn(fs, "writeSync").mockImplementation(() => 0);
        try {
            withTTY(true, () => term.resetKeyboardModesSync());
            expect(writeSync).toHaveBeenCalledWith(1, RESET);
        } finally {
            writeSync.mockRestore();
        }
    });

    test("is a no-op when stdout is not a TTY (don't pollute a redirected stream)", () => {
        const term = new ProcessTerminal() as unknown as { resetKeyboardModesSync(): void };
        const writeSync = spyOn(fs, "writeSync").mockImplementation(() => 0);
        try {
            withTTY(false, () => term.resetKeyboardModesSync());
            expect(writeSync).not.toHaveBeenCalled();
        } finally {
            writeSync.mockRestore();
        }
    });

    test("clears the OSC 9;4 tab progress bar, but only when it was shown", () => {
        const term = new ProcessTerminal() as unknown as {
            resetKeyboardModesSync(): void;
            setProgress(active: boolean): void;
        };
        const writeSync = spyOn(fs, "writeSync").mockImplementation(() => 0);
        const write = spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
            // Never shown → the reset string must not carry OSC 9;4 (old iTerm2
            // renders unknown OSC 9 as a notification popup).
            withTTY(true, () => term.resetKeyboardModesSync());
            expect(writeSync).toHaveBeenLastCalledWith(1, RESET);

            term.setProgress(true);
            expect(write).toHaveBeenCalledWith("\x1b]9;4;3\x07");
            withTTY(true, () => term.resetKeyboardModesSync());
            expect(writeSync).toHaveBeenLastCalledWith(1, `\x1b]9;4;0\x07${RESET}`);

            // The safety net consumed the active flag — a second pass is clean.
            withTTY(true, () => term.resetKeyboardModesSync());
            expect(writeSync).toHaveBeenLastCalledWith(1, RESET);
        } finally {
            term.setProgress(false); // stop the keepalive before the mock lifts
            writeSync.mockRestore();
            write.mockRestore();
        }
    });

    test("setProgress(false) clears once while active, then goes quiet", () => {
        const term = new ProcessTerminal() as unknown as { setProgress(active: boolean): void };
        const write = spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
            term.setProgress(false); // never shown — nothing to clear
            expect(write).not.toHaveBeenCalled();

            term.setProgress(true);
            term.setProgress(false);
            expect(write).toHaveBeenCalledWith("\x1b]9;4;0\x07");

            write.mockClear();
            term.setProgress(false); // already cleared — stays quiet
            expect(write).not.toHaveBeenCalled();
        } finally {
            write.mockRestore();
        }
    });

    test("a fatal signal resets the terminal and exits 128+signo (no re-raise)", () => {
        const term = new ProcessTerminal() as unknown as { onFatalSignal(signal: NodeJS.Signals): void };
        const writeSync = spyOn(fs, "writeSync").mockImplementation(() => 0);
        const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
        try {
            withTTY(true, () => term.onFatalSignal("SIGINT"));
            expect(writeSync).toHaveBeenCalledWith(1, RESET);
            expect(exit).toHaveBeenCalledWith(130); // 128 + 2
        } finally {
            writeSync.mockRestore();
            exit.mockRestore();
        }
    });

    test("install registers signal + exit listeners; remove cleans them up", () => {
        const term = new ProcessTerminal() as unknown as {
            installExitSafetyNet(): void;
            removeExitSafetyNet(): void;
        };
        const base = process.listenerCount("SIGINT");
        term.installExitSafetyNet();
        expect(process.listenerCount("SIGINT")).toBe(base + 1);
        expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);
        expect(process.listenerCount("SIGHUP")).toBeGreaterThan(0);
        // idempotent — no duplicate registration
        term.installExitSafetyNet();
        expect(process.listenerCount("SIGINT")).toBe(base + 1);
        term.removeExitSafetyNet();
        expect(process.listenerCount("SIGINT")).toBe(base);
    });
});
