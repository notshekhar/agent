/**
 * The pty and the terminal session.
 *
 * These run a real shell, because every interesting failure here is at the
 * boundary with the OS — a resize that silently does nothing, writes that
 * arrive out of order, output that never comes back — and none of it shows up
 * against a fake.
 */
import { describe, expect, test } from "bun:test";
import { ptyAvailable, spawnPty } from "../src/terminal/pty";
import { createTerminalSession } from "../src/terminal/session";

const has = ptyAvailable();
const ptyTest = has ? test : test.skip;

/** Wait until `check` passes, or give up. Output arrives asynchronously. */
async function until(check: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (check()) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return check();
}

describe("pty", () => {
    ptyTest(
        "a real shell runs, and its output comes back",
        async () => {
            let out = "";
            const pty = spawnPty({ cmd: "/bin/sh", args: ["-i"], rows: 10, cols: 40 });
            pty.onData((c) => (out += c));
            await until(() => out.length > 0);
            pty.write("echo marker-one\n");
            expect(await until(() => out.includes("marker-one"))).toBe(true);
            pty.kill();
            expect(pty.exited).toBe(true);
        },
        15_000,
    );

    /**
     * `ioctl` is variadic, and on Apple arm64 variadic arguments are passed on
     * the stack while bun:ffi passes declared ones in registers — so the obvious
     * call returns success and writes nothing. pty.ts probes for the form that
     * actually round-trips; if that probe ever regresses, the shell keeps
     * wrapping at the old width and nothing else complains.
     */
    ptyTest(
        "resize reaches the child, not just the ioctl return value",
        async () => {
            let out = "";
            const pty = spawnPty({ cmd: "/bin/sh", args: ["-i"], rows: 24, cols: 80 });
            pty.onData((c) => (out += c));
            await until(() => out.length > 0);

            pty.resize(30, 132);
            out = "";
            // The shell asks the tty itself, so this is the child's view, not ours.
            pty.write("stty size\n");
            const sawSize = await until(() => /\b30\s+132\b/.test(out));
            pty.kill();
            expect(sawSize).toBe(true);
        },
        15_000,
    );

    /**
     * Asynchronous writes to the master reorder, which scrambles multi-chunk
     * input — "echo" arriving as "ech" + "o". pty.ts drains a queue one write
     * at a time; this sends enough separate writes to catch it if that breaks.
     */
    ptyTest(
        "many small writes arrive in order",
        async () => {
            let out = "";
            const pty = spawnPty({ cmd: "/bin/sh", args: ["-i"], rows: 10, cols: 80 });
            pty.onData((c) => (out += c));
            await until(() => out.length > 0);
            for (const ch of "echo ordered-abcdefghij\n") pty.write(ch);
            const ok = await until(() => out.includes("ordered-abcdefghij"));
            pty.kill();
            expect(ok).toBe(true);
        },
        15_000,
    );

    ptyTest(
        "the exit callback fires when the child leaves",
        async () => {
            let code: number | undefined;
            const pty = spawnPty({ cmd: "/bin/sh", args: ["-c", "exit 3"], rows: 10, cols: 40 });
            pty.onExit((c) => (code = c));
            expect(await until(() => code !== undefined)).toBe(true);
            expect(code).toBe(3);
            pty.kill();
        },
        15_000,
    );
});

describe("terminal session", () => {
    ptyTest(
        "renders the shell's screen, and keeps its colours",
        async () => {
            let updated = false;
            const session = createTerminalSession({
                cmd: "/bin/sh",
                args: ["-i"],
                rows: 8,
                cols: 60,
                onUpdate: () => (updated = true),
            });
            await until(() => updated);
            session.handleInput("printf '\\033[31mREDTEXT\\033[0m\\n'\n");
            const ok = await until(() => session.render(60).some((l) => l.includes("REDTEXT")));
            const lines = session.render(60);
            session.kill();

            expect(ok).toBe(true);
            // The colour has to survive the trip through the emulator and back out
            // as ANSI, or the panel renders a wall of undifferentiated text.
            expect(lines.some((l) => /\x1b\[(38;5;1|38;2;)/.test(l))).toBe(true);
        },
        15_000,
    );

    ptyTest(
        "rendering at a new width reflows the child",
        async () => {
            let updated = false;
            const session = createTerminalSession({
                cmd: "/bin/sh",
                args: ["-i"],
                rows: 6,
                cols: 40,
                onUpdate: () => (updated = true),
            });
            await until(() => updated);
            // The panel's width is the authority; asking for 100 must resize the pty.
            session.render(100);
            // The kernel signals the child with SIGWINCH; asking it for its size in
            // the same tick races that delivery, which is a race in the test, not in
            // the resize (the ioctl itself is synchronous).
            await new Promise((r) => setTimeout(r, 250));
            session.handleInput("stty size\n");
            const ok = await until(() => session.render(100).some((l) => /\b100\b/.test(l)));
            session.kill();
            expect(ok).toBe(true);
        },
        15_000,
    );

    ptyTest(
        "every rendered line is exactly the requested width",
        async () => {
            const session = createTerminalSession({ cmd: "/bin/sh", args: ["-i"], rows: 5, cols: 30 });
            await until(() => session.render(30).some((l) => l.length > 0));
            const lines = session.render(30);
            session.kill();
            expect(lines.length).toBe(5);
            // Escapes make the string longer than the column count, so compare the
            // visible text: a short line would leave the frame ragged.
            for (const line of lines) {
                expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBe(30);
            }
        },
        15_000,
    );
});
