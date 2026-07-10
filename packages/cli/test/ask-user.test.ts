/**
 * Drives the ask-tool answer flow (packages/cli/src/interactive/ask-user.ts)
 * through a fake SelectorHost: raw key data goes to the bridge's registered
 * input listeners first (as the real TUI does), then to the focused
 * SelectList. Covers the question navigation (←/→, Esc skip) and the review
 * screen (edit rows, Submit) — the Editor-based "Other"/note paths are not
 * exercised here because they need a real TUI instance.
 */
import { describe, expect, test } from "bun:test";
import { isKeyRelease, type SelectList } from "@notshekhar/loop-tui";
import type { AskQuestion } from "@notshekhar/loop-core";
import { createAskUserBridge } from "../src/interactive/ask-user";
import type { SelectorHost } from "../src/interactive/selectors";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";

type Listener = (d: string) => { consume: boolean } | undefined;

function makeHarness() {
    const listeners = new Set<Listener>();
    let active: SelectList | null = null;
    const stack: (SelectList | null)[] = [];
    const tui = {
        addInputListener(cb: Listener) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        requestRender() {},
    };
    const host = {
        tui,
        showSelector: (_component: unknown, focusable: unknown) => {
            stack.push(active);
            active = focusable as SelectList;
            return () => {
                active = stack.pop() ?? null;
            };
        },
    } as unknown as SelectorHost;
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    // Listeners first, focused list second — mirrors the real TUI dispatch.
    const send = async (...keys: string[]) => {
        for (const data of keys) {
            let consumed = false;
            for (const cb of [...listeners]) {
                if (cb(data)?.consume) {
                    consumed = true;
                    break;
                }
            }
            // The real TUI drops key-release events before the focused
            // component (tui.ts) — listeners above still see them raw.
            if (!consumed && !isKeyRelease(data)) active?.handleInput(data);
            await tick();
        }
    };
    const bridge = createAskUserBridge({ host, editorTheme: {} as never });
    return { bridge, send, tick, current: () => active };
}

const q = (header: string, labels: string[], multiSelect = false): AskQuestion => ({
    question: `${header}?`,
    header,
    options: labels.map((label) => ({ label, description: `${label} desc` })),
    multiSelect,
});

describe("ask-user bridge flow", () => {
    test("answers land on a review screen and resolve only on Submit", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])]);
        await tick();
        await send(ENTER); // Q1 → A
        await send(ENTER); // Q2 → C
        // Review: cursor starts on the Submit row.
        expect(current()?.getSelectedItem()?.value).toBe("__submit__");
        await send(ENTER); // Submit
        expect(await p).toEqual([{ answers: ["A"] }, { answers: ["C"] }]);
    });

    test("a review row reopens its question prefilled and the change sticks", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])]);
        await tick();
        await send(ENTER, ENTER); // A, C → review
        await send("1"); // edit question 1
        expect(current()?.getSelectedItem()?.label).toBe("A"); // prefilled cursor
        await send(DOWN, ENTER); // change to B
        expect(current()?.getSelectedItem()?.value).toBe("__submit__"); // back on review
        await send(ENTER);
        expect(await p).toEqual([{ answers: ["B"] }, { answers: ["C"] }]);
    });

    test("left goes back to the previous question, right returns without losing the answer", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])]);
        await tick();
        await send(ENTER); // Q1 → A, now on Q2
        await send(LEFT); // back to Q1
        expect(current()?.getSelectedItem()?.label).toBe("A"); // answer prefilled
        await send(RIGHT); // forward again, A kept
        await send(ENTER); // Q2 → C
        await send(ENTER); // Submit
        expect(await p).toEqual([{ answers: ["A"] }, { answers: ["C"] }]);
    });

    test("right arrow clamps at the last question — navigation alone never reaches the review", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])]);
        await tick();
        await send(RIGHT, RIGHT, RIGHT); // Q1 → Q2, then clamped on Q2
        expect(current()?.getSelectedItem()?.label).toBe("C"); // still Q2, not the review
        await send(LEFT);
        expect(current()?.getSelectedItem()?.label).toBe("A"); // back on Q1
        await send(ENTER, ENTER, ENTER); // A, C, Submit
        expect(await p).toEqual([{ answers: ["A"] }, { answers: ["C"] }]);
    });

    test("the cursor row survives navigating away and back on a single-select", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])]);
        await tick();
        await send(DOWN); // cursor on B, nothing selected
        await send(RIGHT, LEFT); // away and back
        expect(current()?.getSelectedItem()?.label).toBe("B"); // cursor kept, not reset
        await send(ENTER, ENTER, ENTER); // B, C, Submit
        expect(await p).toEqual([{ answers: ["B"] }, { answers: ["C"] }]);
    });

    test("multi-select ticks survive navigation and count as the answer", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B", "C"], true), q("Q2", ["D", "E"])]);
        await tick();
        await send("1"); // tick A — no "done"
        await send(RIGHT, LEFT); // away and back
        expect(current()?.getSelectedItem()?.label).toBe("[x] A"); // tick kept
        await send(RIGHT); // move on without "done"
        await send(ENTER); // Q2 → D
        await send(UP, UP); // from Submit up to the Q1 row
        expect(current()?.getSelectedItem()?.description).toBe("A"); // ticks became the answer
        await send(DOWN, DOWN, ENTER); // Submit
        expect(await p).toEqual([{ answers: ["A"] }, { answers: ["D"] }]);
    });

    test("a question left unanswered via → shows as skipped on the review and resolves declined", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])]);
        await tick();
        await send(RIGHT); // move past Q1 without answering
        await send(ENTER); // Q2 → C
        await send(UP, UP); // from Submit up to the Q1 row
        expect(current()?.getSelectedItem()?.description).toBe("(skipped)");
        await send(DOWN, DOWN, ENTER); // back down to Submit
        expect(await p).toEqual([{ answers: [], declined: true }, { answers: ["C"] }]);
    });

    test("Esc with nothing answered dismisses the whole ask as declined immediately", async () => {
        const { bridge, send, tick } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])]);
        await tick();
        await send(ESC); // dismiss on Q1 — no review, no more questions
        expect(await p).toEqual([
            { answers: [], declined: true },
            { answers: [], declined: true },
        ]);
    });

    test("Esc with an answer already given lands on the review instead of dropping it", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])]);
        await tick();
        await send(ENTER); // Q1 → A
        await send(ESC); // dismiss on Q2 — A must still be confirmed
        expect(current()?.getSelectedItem()?.value).toBe("__submit__");
        await send(ENTER); // Submit
        expect(await p).toEqual([{ answers: ["A"] }, { answers: [], declined: true }]);
    });

    test("Esc on the review goes back to the last question instead of submitting", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"])]);
        await tick();
        await send(ENTER); // Q1 → A, review shows (single question too)
        expect(current()?.getSelectedItem()?.value).toBe("__submit__");
        await send(ESC); // back to Q1
        await send("2"); // change to B via digit quick pick
        await send(ENTER); // Submit
        expect(await p).toEqual([{ answers: ["B"] }]);
    });

    test("Esc while editing from the review keeps the old answer", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])]);
        await tick();
        await send(ENTER, ENTER); // A, C → review
        await send("1"); // edit question 1
        await send(ESC); // changed my mind — keep A
        expect(current()?.getSelectedItem()?.value).toBe("__submit__"); // back on review
        await send(ENTER); // Submit
        expect(await p).toEqual([{ answers: ["A"] }, { answers: ["C"] }]);
    });

    test("multi-select answers re-seed their checkboxes when edited from the review", async () => {
        const { bridge, send, tick } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B", "C"], true)]);
        await tick();
        await send("1", "2"); // toggle A and B
        await send(DOWN, DOWN, DOWN, DOWN, ENTER); // move to done, confirm
        await send("1"); // edit from review — seeds A and B
        await send("3"); // also toggle C
        await send(DOWN, DOWN, DOWN, DOWN, ENTER); // done again
        await send(ENTER); // Submit
        expect(await p).toEqual([{ answers: ["A", "B", "C"] }]);
    });

    test("a Kitty key-release event does not move a second question", async () => {
        const { bridge, send, tick, current } = makeHarness();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])]);
        await tick();
        // One physical → press under the Kitty protocol: press event then a
        // release event, and matchesKey matches BOTH — only the press may act,
        // or a single arrow press jumps two questions (straight to the review).
        await send(RIGHT, "\x1b[1;1:3C");
        expect(current()?.getSelectedItem()?.label).toBe("C"); // on Q2, not the review
        await send(ENTER, ENTER); // Q2 → C, Submit
        expect(await p).toEqual([{ answers: [], declined: true }, { answers: ["C"] }]);
    });

    test("an abort mid-flow resolves the remaining questions as declined", async () => {
        const { bridge, send, tick } = makeHarness();
        const ac = new AbortController();
        const p = bridge.ask([q("Q1", ["A", "B"]), q("Q2", ["C", "D"])], { signal: ac.signal });
        await tick();
        await send(ENTER); // Q1 → A
        ac.abort();
        await tick();
        expect(await p).toEqual([{ answers: ["A"] }, { answers: [], declined: true }]);
    });
});
