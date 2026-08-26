/**
 * The shells panel's row layout. A row that overflows its width wraps, and a
 * wrapped row changes the panel's HEIGHT — which is the one thing the pinned
 * region must never do on its own (see the committed-rows note in the panel's
 * header). So every case here checks the printed width as well as the content.
 */
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@notshekhar/loop-tui";
import type { ShellInfo } from "@notshekhar/loop-core";
import { formatShellRow, ShellsPanel } from "../src/interactive/components/shells-panel";

function shell(over: Partial<ShellInfo> = {}): ShellInfo {
    return {
        id: "bash_1",
        command: "bun run dev",
        cwd: "/repo",
        pid: 1234,
        status: "running",
        exitCode: null,
        startedAt: Date.now() - 134_000,
        endedAt: null,
        logPath: "/tmp/bash_1.log",
        bytes: 0,
        cursor: 0,
        preview: [],
        promoted: false,
        ...over,
    };
}

describe("row layout", () => {
    test("fits the width exactly at a normal terminal size", () => {
        const row = formatShellRow(shell({ preview: ["ready in 340ms"] }), 100);
        expect(visibleWidth(row)).toBe(100);
        expect(row).toContain("bash_1");
        expect(row).toContain("bun run dev");
        expect(row).toContain("ready in 340ms");
        expect(row).toContain("2m14s");
    });

    test("never overflows, however narrow", () => {
        for (const width of [20, 30, 40, 60, 80, 120, 200]) {
            const row = formatShellRow(shell({ preview: ["ready in 340ms"] }), width);
            expect(visibleWidth(row)).toBeLessThanOrEqual(width);
        }
    });

    test("the id and status survive when the command does not", () => {
        // What matters on a narrow screen is which shell this is and what it
        // is doing — not the full command line.
        const row = formatShellRow(shell({ command: "a".repeat(300) }), 34);
        expect(row).toContain("bash_1");
        expect(row).toContain("2m14s");
        expect(visibleWidth(row)).toBeLessThanOrEqual(34);
    });

    test("a long output line is clipped, not wrapped", () => {
        const row = formatShellRow(shell({ preview: ["x".repeat(400)] }), 100);
        expect(visibleWidth(row)).toBe(100);
    });

    test("the hint is dropped rather than shown as a stub", () => {
        // Too little room for a meaningful hint: better nothing than "r…".
        const row = formatShellRow(shell({ command: "b".repeat(60), preview: ["ready"] }), 80);
        expect(row).not.toContain("ready");
        expect(visibleWidth(row)).toBeLessThanOrEqual(80);
    });

    test("status reads the exit, not the process state", () => {
        expect(formatShellRow(shell({ status: "exited", exitCode: 0 }), 80)).toContain("done");
        expect(formatShellRow(shell({ status: "exited", exitCode: 1 }), 80)).toContain("exit 1");
        expect(formatShellRow(shell({ status: "killed" }), 80)).toContain("killed");
        expect(formatShellRow(shell({ status: "failed" }), 80)).toContain("failed");
    });
});

describe("panel", () => {
    test("costs nothing when there is nothing to show", () => {
        expect(new ShellsPanel().render(100)).toEqual([]);
    });

    test("a running shell is never pushed off by a finished one", () => {
        const panel = new ShellsPanel();
        const finished = Array.from({ length: 6 }, (_, i) =>
            shell({ id: `bash_${i + 1}`, status: "exited", exitCode: 0, endedAt: Date.now() - i }),
        );
        panel.setShells([...finished, shell({ id: "bash_live" })]);
        const rows = panel.render(100);
        expect(rows.some((r) => r.includes("bash_live"))).toBe(true);
        expect(rows.at(-1)).toContain("more");
    });

    test("retiring at the turn boundary keeps only what is still running", () => {
        const panel = new ShellsPanel();
        panel.setShells([shell({ id: "bash_1", status: "exited", exitCode: 0 }), shell({ id: "bash_2" })]);
        panel.retireFinished();
        const rows = panel.render(100);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toContain("bash_2");
    });
});
