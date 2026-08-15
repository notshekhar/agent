import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { registerNoirMode } from "../src/interactive/ui/noir-mode";
import { setActiveUiMode, setLiveVariant, uiStyle } from "../src/interactive/ui/ui-mode";
import { initTheme } from "../src/interactive/ui/theme";
import { ChatHistory } from "../src/interactive/components/chat-history";

beforeAll(() => {
    registerNoirMode();
});

afterEach(() => {
    setLiveVariant(false);
    setActiveUiMode("loop");
    initTheme("dark");
});

/** Noir, in its live variant — what ctrl+e puts you in. */
const liveOn = () => {
    setActiveUiMode("noir");
    initTheme("night");
    setLiveVariant(true);
};

const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const W = 70;

/** A history with `n` finished read calls in a row. */
function withReads(n: number, tool = "read"): ChatHistory {
    const h = new ChatHistory(tui, "/repo");
    for (let i = 0; i < n; i++) {
        h.addToolCall(tool, `c${i}`, { path: `/repo/f${i}.ts` });
        h.addToolResult(`c${i}`, "body");
    }
    return h;
}

const text = (h: ChatHistory) => h.render(W).map(strip).join("\n");

describe("noir's live variant", () => {
    test("live layers over the mode you are already in", () => {
        liveOn();
        const s = uiStyle();
        // The variant adds grouping...
        expect(s.tool.group).toBe(true);
        // ...without disturbing noir's own look underneath it.
        expect(s.canvas.wash).toBe(true);
        expect(s.userMessage.prefix).toBe("\u276f");
    });

    test("noir on its own does not group — that is the live variant's doing", () => {
        setActiveUiMode("noir");
        initTheme("night");
        expect(uiStyle().tool.group).toBe(false);
        expect(text(withReads(3))).not.toContain("Read 3 files");
    });

    test("loop has no live variant, so ctrl+e leaves its look alone", () => {
        setActiveUiMode("loop");
        initTheme("dark");
        const before = uiStyle();
        setLiveVariant(true);
        const after = uiStyle();
        expect(after.tool.group).toBe(false);
        expect(after.canvas.wash).toBe(before.canvas.wash);
    });
});

describe("live verb groups", () => {
    test("a run of finished tool rows folds into one aggregated header", () => {
        liveOn();
        const out = text(withReads(3));
        expect(out).toContain("◈ Read 3 files");
        expect(out).not.toContain("f0.ts");
    });

    test("one member is enough to fold", () => {
        // grok folds from the first call (RunScan::folds), so a second one
        // joins an existing header instead of the row collapsing under you.
        liveOn();
        const out = text(withReads(1));
        expect(out).toContain("◈ Read 1 file");
        expect(out).not.toContain("f0.ts");
    });

    test("a mixed run names every kind with its own count", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("ls", "a", { path: "/repo" });
        h.addToolResult("a", "x");
        h.addToolCall("ls", "b", { path: "/repo/src" });
        h.addToolResult("b", "x");
        h.addToolCall("read", "c", { path: "/repo/a.ts" });
        h.addToolResult("c", "x");
        expect(text(h)).toContain("◈ Listed 2 dirs, Read 1 file");
    });

    test("a hidden failure is still reported on the header", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("read", "a", { path: "/repo/a.ts" });
        h.addToolResult("a", "x");
        h.addToolCall("read", "b", { path: "/repo/gone.ts" });
        h.addToolResult("b", "ENOENT", true);
        // Folding must never be a way to lose bad news.
        expect(text(h)).toContain("· 1 failed");
    });

    test("commands fold too — the run is one line, the detail is one key away", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("bash", "a", { command: "npm run build" });
        h.addToolResult("a", "x");
        h.addToolCall("bash", "b", { command: "npm test" });
        h.addToolResult("b", "x");
        const out = text(h);
        expect(out).toContain("◈ Ran 2 commands");
        expect(out).not.toContain("npm run build");
    });

    test("edits fold too — the run is one line", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("edit", "a", { path: "/repo/a.ts" });
        h.addToolResult("a", "x");
        h.addToolCall("write", "b", { path: "/repo/b.ts" });
        h.addToolResult("b", "x");
        expect(text(h)).toContain("◈ Edited 2 files");
    });

    test("MCP calls fold by source, however the server spelled them", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("sentry__list_errors", "a", {});
        h.addToolResult("a", "x");
        h.addToolCall("sentry__get_error", "b", {});
        h.addToolResult("b", "x");
        // Both in one group: folding must not depend on the tool's spelling,
        // and the noun must not be borrowed from a builtin ("Listed 2 dirs").
        expect(text(h)).toContain("◈ Called 2 MCP tools");
    });

    test("a non-folding call breaks the run around it", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("read", "a", { path: "/repo/a.ts" });
        h.addToolResult("a", "x");
        // `ask` is a surface the user answers, so it never folds — which makes
        // it the thing that splits a run in two.
        h.addToolCall("ask", "b", {});
        h.addToolResult("b", "x");
        h.addToolCall("read", "c", { path: "/repo/c.ts" });
        h.addToolResult("c", "x");
        const out = text(h).split("\n").filter(Boolean);
        expect(out.filter((l) => l.includes("◈ Read 1 file"))).toHaveLength(2);
    });

    test("a running call keeps its own row — grouping happens once it lands", () => {
        liveOn();
        const h = withReads(2);
        h.addToolCall("read", "live", { path: "/repo/slow.ts" }); // no result → running
        // Live mode is the base look plus folding: in flight the call reads
        // exactly as it does in normal noir, naming the file it is reading.
        const out = text(h);
        expect(out).toContain("◈ Read 2 files");
        expect(out).toContain("slow.ts");
        expect(out).not.toContain("Reading 3 files");
    });

    test("a call joins the group in front of it the moment it finishes", () => {
        liveOn();
        const h = withReads(2);
        h.addToolCall("read", "live", { path: "/repo/slow.ts" });
        h.addToolResult("live", "body");
        const out = text(h);
        expect(out).toContain("◈ Read 3 files");
        expect(out).not.toContain("slow.ts");
    });

    test("only the running call sits outside the header", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("read", "done", { path: "/repo/a.ts" });
        h.addToolResult("done", "x");
        h.addToolCall("read", "live", { path: "/repo/b.ts" });
        const out = text(h);
        expect(out).toContain("◈ Read 1 file"); // the finished one, folded
        expect(out).toContain("b.ts"); // the live one, still a row
    });
});

describe("live hierarchical navigation", () => {
    test("selection lands on the group header, not on a row that isn't drawn", () => {
        liveOn();
        const h = withReads(3);
        expect(h.selectLast()).toBe(true);
        expect(text(h)).toContain("◈ Read 3 files");
    });

    test("→ opens the group first, then the call's output", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();

        h.setSelectedExpanded(true); // level 1: the group
        const opened = text(h);
        expect(opened).not.toContain("◈ Read 3 files");
        expect(opened).toContain("f0.ts");
        expect(opened).toContain("f2.ts");
        expect(opened).not.toContain("body"); // contents still folded

        h.setSelectedExpanded(true); // level 2: the selected call
        expect(text(h)).toContain("body");
    });

    test("opening a member does not re-collapse its siblings", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();
        h.setSelectedExpanded(true);
        h.setSelectedExpanded(true);
        // Expanding the head drops it out of the run; the remaining two must
        // NOT snap shut into a fresh "Read 2 files" header.
        const out = text(h);
        expect(out).not.toContain("◈");
        expect(out).toContain("f1.ts");
        expect(out).toContain("f2.ts");
    });

    test("← walks back out: fold the call, then close the group", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();
        h.setSelectedExpanded(true);
        h.setSelectedExpanded(true);
        expect(text(h)).toContain("body");

        h.setSelectedExpanded(false);
        expect(text(h)).not.toContain("body"); // call folded, group still open

        h.setSelectedExpanded(false);
        expect(text(h)).toContain("◈ Read 3 files"); // group closed
    });

    test("Enter opens a closed group — same first step as →", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();
        expect(h.toggleSelected()).toBe(true);
        expect(text(h)).not.toContain("◈ Read 3 files");
    });

    test("leaving navigation puts the folds back the way the mode wants them", () => {
        // Expanding is a navigation affordance — `e`, → and Enter only exist
        // inside nav. Carrying those opens back to the prompt left chat mode
        // in a state the user never chose and had no key to undo.
        liveOn();
        const h = withReads(3);
        h.selectLast();
        h.setSelectedExpanded(true); // open the group
        h.setSelectedExpanded(true); // open the call's output
        expect(text(h)).toContain("body");

        h.clearSelection();
        h.resetFolds();

        const out = text(h);
        expect(out).toContain("◈ Read 3 files"); // grouped again
        expect(out).not.toContain("body"); // output folded again
        expect(out).not.toContain("f0.ts");
    });

    test("expand-all does not survive the trip back to the prompt either", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();
        h.toggleToolsExpanded(); // `e`
        expect(text(h)).toContain("body");

        h.resetFolds();
        expect(text(h)).not.toContain("body");
        // A later `e` still toggles from closed, rather than being stuck open.
        expect(h.toggleToolsExpanded()).toBe(true);
    });

    test("normal noir gets its own default back, not live's grouping", () => {
        // The mode decides what "default" means; resetFolds only undoes the
        // navigation opens.
        setActiveUiMode("noir");
        initTheme("night");
        const h = withReads(3);
        h.selectLast();
        h.setSelectedExpanded(true);
        expect(text(h)).toContain("body");

        h.resetFolds();
        const out = text(h);
        expect(out).not.toContain("body"); // folded
        expect(out).not.toContain("◈ Read 3 files"); // but never grouped here
        expect(out).toContain("f0.ts");
    });

    test("loop mode resets the same way", () => {
        // Loop shows a short result inline, so the tell here is length: a long
        // output is previewed until you open it, and closed again afterwards.
        setActiveUiMode("loop");
        initTheme("dark");
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("read", "c0", { path: "/repo/f0.ts" });
        h.addToolResult("c0", Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
        const folded = text(h).split("\n").length;
        h.selectLast();
        h.setSelectedExpanded(true);
        const opened = text(h).split("\n").length;
        expect(opened).toBeGreaterThan(folded);

        h.resetFolds();
        expect(text(h).split("\n").length).toBe(folded);
    });

    test("moveSelection never stops on an entry hidden in a group", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("go");
        for (let i = 0; i < 3; i++) {
            h.addToolCall("read", `c${i}`, { path: `/repo/f${i}.ts` });
            h.addToolResult(`c${i}`, "body");
        }
        h.selectLast(); // group header
        // Walking up from the header reaches the user prompt, never a hidden row.
        expect(h.moveSelection(-1)).toBe(true);
        const out = text(h);
        expect(out).toContain("◈ Read 3 files");
        expect(out).toContain("go");
    });
});
