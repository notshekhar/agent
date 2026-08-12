import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { registerNoirMode } from "../src/interactive/ui/noir-mode";
import { LIVE_MODE_ID, registerLiveMode } from "../src/interactive/ui/live-mode";
import { setActiveUiMode, uiStyle } from "../src/interactive/ui/ui-mode";
import { initTheme } from "../src/interactive/ui/theme";
import { ChatHistory } from "../src/interactive/components/chat-history";
import { settingsStore } from "@notshekhar/loop-core";

beforeAll(() => {
    registerNoirMode();
    registerLiveMode();
});

afterEach(() => {
    setActiveUiMode("loop");
    initTheme("dark");
});

const liveOn = () => {
    setActiveUiMode(LIVE_MODE_ID);
    initTheme("night");
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

describe("live mode style", () => {
    test("declares the two behaviours that make it its own mode", () => {
        liveOn();
        const s = uiStyle();
        expect(s.tool.group).toBe(true);
        expect(s.layout.pinnedInput).toBe(true);
    });

    test("noir does NOT group — grouping is live mode's alone", () => {
        setActiveUiMode("noir");
        initTheme("night");
        expect(uiStyle().tool.group).toBe(false);
        expect(text(withReads(3))).not.toContain("Read 3 files");
    });
});

describe("pinnedInput setting", () => {
    /** A transcript taller than the 20-row terminal below. */
    const tall = (h: ChatHistory) => {
        for (let i = 0; i < 30; i++) h.addUser(`message number ${i}`);
        return h;
    };
    const smallTui = { requestRender() {}, terminal: { rows: 20, columns: 80 } } as unknown as TUI;

    afterEach(() => settingsStore.set("pinnedInput", undefined));

    test("off: the transcript renders in full and scrolls the terminal", () => {
        settingsStore.set("pinnedInput", false);
        const h = tall(new ChatHistory(smallTui, "/repo"));
        h.applyPinnedInputSetting();
        expect(h.render(60).length).toBeGreaterThan(20);
    });

    test("on: the transcript is clipped to a window, so the prompt stays put", () => {
        settingsStore.set("pinnedInput", true);
        const h = tall(new ChatHistory(smallTui, "/repo"));
        h.applyPinnedInputSetting();
        const out = h.render(60);
        expect(out.length).toBeLessThanOrEqual(20);
        // Clipped from the top: the window sits at the newest end.
        expect(out.map(strip).join("\n")).toContain("message number 29");
    });

    test("on: leaving live mode does NOT un-pin the prompt", () => {
        settingsStore.set("pinnedInput", true);
        const h = tall(new ChatHistory(smallTui, "/repo"));
        h.applyPinnedInputSetting();
        h.setViewport(true); // ctrl+e in
        h.setViewport(false); // ctrl+e out
        expect(h.render(60).length).toBeLessThanOrEqual(20);
    });

    test("off: leaving live mode releases the window as before", () => {
        settingsStore.set("pinnedInput", false);
        const h = tall(new ChatHistory(smallTui, "/repo"));
        h.setViewport(true);
        h.setViewport(false);
        expect(h.render(60).length).toBeGreaterThan(20);
    });
});

describe("live mode verb groups", () => {
    test("a run of finished tool rows folds into one aggregated header", () => {
        liveOn();
        const out = text(withReads(3));
        expect(out).toContain("◇ Read 3 files · 3");
        expect(out).not.toContain("f0.ts");
    });

    test("a lone call is never grouped — a header hiding one row buys nothing", () => {
        liveOn();
        const out = text(withReads(1));
        expect(out).not.toContain("◇");
        expect(out).toContain("f0.ts");
    });

    test("mixed tools aggregate as a plain count, one tool by its verb", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("read", "a", { path: "/repo/a.ts" });
        h.addToolResult("a", "x");
        h.addToolCall("bash", "b", { command: "ls" });
        h.addToolResult("b", "x");
        expect(text(h)).toContain("◇ 2 tool calls · 2");
        expect(text(withReads(2, "bash"))).toContain("◇ Ran 2 commands · 2");
    });

    test("a RUNNING call never hides inside a group", () => {
        liveOn();
        const h = withReads(2);
        h.addToolCall("bash", "live", { command: "npm test" }); // no result → running
        const out = text(h);
        expect(out).toContain("◇ Read 2 files · 2");
        expect(out).toContain("npm test");
    });
});

describe("live mode hierarchical navigation", () => {
    test("selection lands on the group header, not on a row that isn't drawn", () => {
        liveOn();
        const h = withReads(3);
        expect(h.selectLast()).toBe(true);
        expect(text(h)).toContain("◇ Read 3 files");
    });

    test("→ opens the group first, then the call's output", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();

        h.setSelectedExpanded(true); // level 1: the group
        const opened = text(h);
        expect(opened).not.toContain("◇ Read 3 files");
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
        expect(out).not.toContain("◇");
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
        expect(text(h)).toContain("◇ Read 3 files · 3"); // group closed
    });

    test("Enter opens a closed group — same first step as →", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();
        expect(h.toggleSelected()).toBe(true);
        expect(text(h)).not.toContain("◇ Read 3 files");
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
        expect(out).toContain("◇ Read 3 files");
        expect(out).toContain("go");
    });
});
