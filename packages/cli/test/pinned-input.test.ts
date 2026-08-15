import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { setActiveUiMode } from "../src/interactive/ui/ui-mode";
import { initTheme } from "../src/interactive/ui/theme";
import { ChatHistory } from "../src/interactive/components/chat-history";

const ROWS = 24;
const W = 70;

let terminal = { rows: ROWS, columns: 80 };
const tui = {
    requestRender() {},
    get terminal() {
        return terminal;
    },
} as unknown as TUI;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const lines = (h: ChatHistory) => h.render(W).map(strip);

beforeEach(() => {
    terminal = { rows: ROWS, columns: 80 };
    setActiveUiMode("loop");
    initTheme("dark");
});

afterEach(() => {
    setActiveUiMode("loop");
    initTheme("dark");
});

/** A transcript far taller than any window we give it. */
function tallHistory(messages = 40): ChatHistory {
    const h = new ChatHistory(tui, "/repo");
    for (let i = 0; i < messages; i++) h.addSystem(`line ${i}`);
    return h;
}

describe("pinned input — the window", () => {
    test("unpinned, the transcript renders in full and grows the screen", () => {
        const h = tallHistory();
        // This is the behaviour the setting exists to change: nothing clips it,
        // so a long turn pushes the prompt down and off the terminal.
        expect(lines(h).length).toBeGreaterThan(ROWS);
    });

    test("pinned, the transcript never outgrows the rows left for it", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        expect(lines(h).length).toBe(ROWS - 8);
    });

    test("the reserve is what the chrome actually takes, not a constant", () => {
        const h = tallHistory();
        let chrome = 8;
        h.setReserveRows(() => chrome);
        h.setPinned(true);
        expect(lines(h).length).toBe(ROWS - 8);
        // A draft grows the editor mid-session; the window has to give those
        // rows back, or the frame overflows and the prompt walks off screen.
        chrome = 14;
        expect(lines(h).length).toBe(ROWS - 14);
    });

    test("the frame fits the terminal for every chrome height", () => {
        const h = tallHistory(200);
        for (const chrome of [6, 8, 11, 15, 17]) {
            h.setReserveRows(() => chrome);
            h.setPinned(true);
            // What the app actually paints: window + chrome. Anything over the
            // terminal's rows scrolls it, which un-pins the prompt.
            expect(lines(h).length + chrome).toBeLessThanOrEqual(ROWS);
        }
    });

    test("an empty session pins the prompt too", () => {
        // The whole point: the prompt sits on the same rows from the first
        // keystroke, instead of starting under the banner and sinking to the
        // bottom at some unannounced message count.
        const h = new ChatHistory(tui, "/repo");
        h.setReserveRows(() => 8);
        h.setPinned(true);
        expect(lines(h).length).toBe(ROWS - 8);
    });

    test("a nearly empty session pins the prompt at the same rows as a full one", () => {
        const short = new ChatHistory(tui, "/repo");
        short.addSystem("only one line");
        short.setReserveRows(() => 8);
        short.setPinned(true);

        const long = tallHistory();
        long.setReserveRows(() => 8);
        long.setPinned(true);

        expect(lines(short).length).toBe(lines(long).length);
    });

    test("a short transcript sits at the BOTTOM of its window, next to the prompt", () => {
        const h = new ChatHistory(tui, "/repo");
        h.addSystem("first thing said");
        h.setReserveRows(() => 8);
        h.setPinned(true);
        const out = lines(h);
        // Blank above, content on the last row — the chat grows up out of the
        // prompt rather than starting a screen away from it.
        expect(out[0]).toBe("");
        expect(out[out.length - 1]).toContain("first thing said");
    });

    test("unpinned, a short transcript is still left where it is", () => {
        // Nav mode is temporary; padding there would shunt the screen on Tab.
        const h = new ChatHistory(tui, "/repo");
        h.addSystem("only one line");
        h.setReserveRows(() => 8);
        h.setViewport(true);
        expect(lines(h).length).toBeLessThan(ROWS - 8);
    });

    test("clicking a padded short transcript still selects the right entry", () => {
        // The pad shifts every transcript line down the window; a click that
        // did not account for it would select an entry rows away from the
        // pointer (or miss into the blank and do nothing).
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("read", "c0", { path: "/repo/only.ts" });
        h.addToolResult("c0", "body");
        h.setReserveRows(() => 8);
        h.setPinned(true);
        const out = lines(h);
        const row = out.findIndex((l) => l.includes("only.ts"));
        expect(row).toBeGreaterThan(0);
        expect(h.clickAtLocalLine(row)).toBe(true);
        expect(h.hasSelection()).toBe(true);
        // The blank pad above is not a click target.
        h.clearSelection();
        expect(h.clickAtLocalLine(0)).toBe(false);
    });
});

describe("pinned input — following the live edge", () => {
    test("a pinned session opens on its newest line", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        expect(lines(h).join("\n")).toContain("line 39");
    });

    test("new output keeps the window at the bottom", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        lines(h);
        h.addSystem("the newest line");
        expect(lines(h).join("\n")).toContain("the newest line");
    });

    test("scrolling up stops the follow, so a streaming turn can be read", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        lines(h);
        h.scrollViewportLines(-8);
        const parked = lines(h).join("\n");
        expect(parked).not.toContain("line 39");
        // The turn keeps streaming underneath — the window must not chase it.
        h.addSystem("newer still");
        expect(lines(h).join("\n")).not.toContain("newer still");
    });

    test("scrolling back to the bottom re-arms the follow", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        lines(h);
        h.scrollViewportLines(-8);
        lines(h);
        h.scrollViewportEdge("bottom");
        lines(h);
        h.addSystem("live again");
        expect(lines(h).join("\n")).toContain("live again");
    });

    test("a window that was scrolled up, then emptied, comes back following", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        lines(h);
        h.scrollViewportLines(-10);
        lines(h);
        // /clear, /new, a mode switch: the transcript is replaced wholesale.
        h.reset();
        for (let i = 0; i < 40; i++) h.addSystem(`fresh ${i}`);
        expect(lines(h).join("\n")).toContain("fresh 39");
    });

    test("scrolled away, the window says how much is below it", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        lines(h);
        h.scrollViewportLines(-8);
        const out = lines(h).join("\n");
        expect(out).toMatch(/▼ \d+ more lines/);
        expect(out).toMatch(/▲ \d+ more lines/);
    });
});

describe("pinned input — getting back to the live edge", () => {
    test("jumpToLiveEdge returns a scrolled-away window to the newest line", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        lines(h);
        h.scrollViewportLines(-20);
        expect(lines(h).join("\n")).not.toContain("line 39");
        h.jumpToLiveEdge();
        expect(lines(h).join("\n")).toContain("line 39");
    });

    test("and it stays followed afterwards", () => {
        // Half a fix would land you at the bottom and then desert you on the
        // next delta of the very turn you sent.
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        lines(h);
        h.scrollViewportLines(-20);
        lines(h);
        h.jumpToLiveEdge();
        lines(h);
        h.addSystem("the reply arriving");
        expect(lines(h).join("\n")).toContain("the reply arriving");
    });

    test("a turn submitted from far up the transcript is not sent into the void", () => {
        // The whole bug: send a message while scrolled back and the reply
        // renders below the fold, so the send looks like it did nothing.
        const turnRunnerSource = readFileSync(
            join(import.meta.dir, "..", "src", "interactive", "turn-runner.ts"),
            "utf8",
        );
        expect(turnRunnerSource).toContain("history.jumpToLiveEdge()");
    });
});

describe("pinned input — surviving a resize", () => {
    /** Numbered entries on screen, in order. */
    const visibleEntries = (rendered: string[]): number[] =>
        rendered.flatMap((l) => Array.from(l.matchAll(/entry(\d+)\b/g), (m) => Number(m[1])));

    /**
     * A transcript that genuinely REFLOWS. This matters: short rows that fit
     * every width drift by zero on a resize whether or not anything anchors
     * them, so a test built on those passes with the fix ripped out.
     */
    function wrappingHistory(): ChatHistory {
        const h = new ChatHistory(tui, "/repo");
        for (let i = 0; i < 40; i++) {
            h.addUser(`entry${i} ` + "prose long enough that narrowing the terminal rewraps it ".repeat(2));
        }
        h.setReserveRows(() => 8);
        h.setPinned(true);
        return h;
    }

    test("a parked window stays on the entry it was parked on", () => {
        const h = wrappingHistory();
        lines(h);
        h.scrollViewportLines(-24);
        const before = visibleEntries(lines(h))[0];
        expect(before).toBeDefined();

        // Measured drift for this transcript with no anchoring: 5 entries at
        // width 46, 9 at 34, 14 at 26 — the window walks away from what you
        // were reading, further the harder you resize. Anchored, the most it
        // moves is onto the start of the entry that was straddling the top.
        for (const width of [46, 34, 26]) {
            const after = visibleEntries(h.render(width).map(strip))[0];
            expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
            h.render(70); // back to the starting width for the next step
        }
    });

    test("a window at the live edge is still at the live edge after a resize", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        expect(lines(h).join("\n")).toContain("line 39");
        expect(h.render(48).map(strip).join("\n")).toContain("line 39");
    });
});

describe("pinned input — asking the terminal for the wheel", () => {
    // This one is a source-order assertion because the failure it guards has no
    // in-process symptom: the window scrolls perfectly on any wheel report it
    // is given, and every test above still passes, while the real terminal
    // silently keeps the wheel and the feature does nothing.
    //
    // terminal.start() opens with a cleanse (`?1000l ?1006l`) that clears modes
    // a SIGKILLed predecessor left on. A request for wheel reports made before
    // start() is inside what that cleanse wipes. The canvas wash sits here for
    // the same reason — see the comment beside it.
    const appSource = readFileSync(join(import.meta.dir, "..", "src", "interactive", "app.ts"), "utf8");

    test("the wheel is requested after the terminal starts, not before", () => {
        const start = appSource.indexOf("tui.start()");
        const request = appSource.indexOf("applyPinnedInput(true)");
        expect(start).toBeGreaterThan(-1);
        expect(request).toBeGreaterThan(-1);
        expect(request).toBeGreaterThan(start);
    });

    test("turning it off withdraws both mouse modes", () => {
        // Left on, the terminal keeps reporting drags instead of selecting text.
        expect(appSource).toContain("\\x1b[?1000l\\x1b[?1006l");
    });
});

describe("pinned input — living alongside nav mode", () => {
    test("leaving navigation does not unpin", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        h.setViewport(true); // Tab into navigation
        h.setViewport(false); // Esc back out
        expect(h.isPinned()).toBe(true);
        expect(lines(h).length).toBe(ROWS - 8);
    });

    test("unpinned, leaving navigation still gives the full transcript back", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setViewport(true);
        expect(lines(h).length).toBe(ROWS - 8);
        h.setViewport(false);
        expect(lines(h).length).toBeGreaterThan(ROWS);
    });

    test("a resized terminal re-budgets the window", () => {
        const h = tallHistory();
        h.setReserveRows(() => 8);
        h.setPinned(true);
        expect(lines(h).length).toBe(ROWS - 8);
        terminal = { rows: 40, columns: 80 };
        expect(lines(h).length).toBe(40 - 8);
    });
});
