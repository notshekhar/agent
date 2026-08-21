/**
 * The tab title: what a terminal (and cmux's pane card) reads when nobody is
 * looking at the transcript. Two halves — the session's name and the state
 * glyph — written by two different things, so the tests here are mostly about
 * one not erasing the other, and about the title never outliving its session.
 */
import { describe, expect, test } from "bun:test";
import { PRODUCT_TITLE } from "@notshekhar/loop-core";
import { createAgentStatusBus } from "../src/interactive/agent-status";
import { attachTerminalTitle, defaultTabName, setTabName } from "../src/interactive/session-title";
import type { AppDeps } from "../src/interactive/deps";

/** Records every title written, in order. */
function fakeDeps(): { deps: AppDeps; titles: string[] } {
    const titles: string[] = [];
    return { deps: { tui: { setTitle: (t: string) => titles.push(t) } } as unknown as AppDeps, titles };
}

describe("tab title", () => {
    test("an untitled session's tab says which agent this pane is", () => {
        expect(defaultTabName()).toBe(PRODUCT_TITLE);
        expect(defaultTabName()).toBe("Loop Agent");
    });

    test("attaching paints the initial title", () => {
        const { deps, titles } = fakeDeps();
        const stop = attachTerminalTitle(createAgentStatusBus(), deps, "Fix the pty test");
        expect(titles.at(-1)).toBe("Fix the pty test");
        stop();
    });

    test("a turn spins in front of the title, and idle leaves the bare name", async () => {
        const { deps, titles } = fakeDeps();
        // settleMs 0: downward transitions still go through a timer, they just
        // don't wait — one macrotask is enough to see idle.
        const bus = createAgentStatusBus(0);
        const stop = attachTerminalTitle(bus, deps, "Fix the pty test");

        bus.setWorking();
        expect(titles.at(-1)).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Fix the pty test$/);

        const closeModal = bus.modalOpened("approve bash");
        expect(titles.at(-1)).toBe("◆ Fix the pty test");
        closeModal();

        bus.setIdle();
        await new Promise((r) => setTimeout(r, 5));
        expect(titles.at(-1)).toBe("Fix the pty test");
        stop();
    });

    test("a title arriving mid-turn keeps the spinner", () => {
        const { deps, titles } = fakeDeps();
        const bus = createAgentStatusBus();
        const stop = attachTerminalTitle(bus, deps, defaultTabName());

        bus.setWorking();
        setTabName(deps, "Fix the pty test");
        expect(titles.at(-1)).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Fix the pty test$/);
        stop();
    });

    test("/new hands the tab back its standing name", () => {
        const { deps, titles } = fakeDeps();
        const bus = createAgentStatusBus();
        const stop = attachTerminalTitle(bus, deps, defaultTabName());

        setTabName(deps, "Fix the pty test");
        expect(titles.at(-1)).toBe("Fix the pty test");

        // What newSession() does once the session is gone.
        setTabName(deps, defaultTabName());
        expect(titles.at(-1)).toBe("Loop Agent");
        stop();
    });

    test("stopping leaves a plain title, not an animation frame", () => {
        const { deps, titles } = fakeDeps();
        const bus = createAgentStatusBus();
        const stop = attachTerminalTitle(bus, deps, "Fix the pty test");
        bus.setWorking();
        stop();
        expect(titles.at(-1)).toBe("Fix the pty test");
    });
});
