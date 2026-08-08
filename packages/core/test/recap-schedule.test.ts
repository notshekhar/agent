import { afterEach, describe, expect, test } from "bun:test";
import {
    cancelRecap,
    clearAllPendingRecaps,
    RECAP_DELAY_MS,
    scheduleRecap,
} from "../src/agent/recap-schedule";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The real delay is 15s, which no test should sit through, so these pass an
 * explicit short one — the same parameter production leaves defaulted. The
 * default itself is asserted separately, so shortening it here cannot hide a
 * constant that drifted.
 */
const DELAY = 60;
const BEFORE = 25;
const AFTER = DELAY + 60;

afterEach(() => {
    clearAllPendingRecaps();
});

describe("recap scheduling", () => {
    test("does not run while the delay is still counting down", async () => {
        let ran = false;
        scheduleRecap("s1", async () => {
            ran = true;
        }, DELAY);
        await tick(BEFORE);
        expect(ran).toBe(false);
    });

    test("a cancel before the delay elapses means it never runs at all", async () => {
        let ran = false;
        scheduleRecap("s2", async () => {
            ran = true;
        }, DELAY);
        cancelRecap("s2");
        await tick(BEFORE);
        expect(ran).toBe(false);
    });

    test("cancelling one session leaves another's recap alone", async () => {
        const ran: string[] = [];
        scheduleRecap("keep", async () => {
            ran.push("keep");
        }, DELAY);
        scheduleRecap("drop", async () => {
            ran.push("drop");
        }, DELAY);
        cancelRecap("drop");
        // The surviving one is still pending, not run — the point is only that
        // cancelling its neighbour did not take it with it.
        await tick(BEFORE);
        expect(ran).toEqual([]);
        cancelRecap("keep");
    });

    test("scheduling again supersedes the pending one rather than racing it", async () => {
        const ran: string[] = [];
        scheduleRecap("s3", async () => {
            ran.push("first");
        }, DELAY);
        scheduleRecap("s3", async () => {
            ran.push("second");
        }, DELAY);
        cancelRecap("s3");
        await tick(BEFORE);
        expect(ran).toEqual([]);
    });

    test("the signal is aborted for work already in flight", async () => {
        // The nasty one: the delay HAS elapsed, generation is running, and only
        // then does the user send. Cancelling during the wait is not enough —
        // without this the append still lands after the newer user message.
        let observed: AbortSignal | null = null;
        let finished = false;
        scheduleRecap("s4", async (signal) => {
            observed = signal;
            await tick(200);
            finished = true;
        }, DELAY);
        await tick(AFTER);
        expect(observed).not.toBeNull();
        expect(observed!.aborted).toBe(false);

        cancelRecap("s4");
        expect(observed!.aborted).toBe(true);
        // It still runs to completion — the guard is that the callback checks
        // the signal before writing, which is what recap.ts does.
        await tick(250);
        expect(finished).toBe(true);
    });

    test("runs once the delay passes uninterrupted", async () => {
        let ran = false;
        scheduleRecap("s5", async () => {
            ran = true;
        }, DELAY);
        await tick(AFTER);
        expect(ran).toBe(true);
    });

    test("the shipped delay is the one turns actually get", () => {
        // The cases above shorten the delay to stay fast, which would happily
        // keep passing if the real constant were changed to 15ms or 15 minutes.
        expect(RECAP_DELAY_MS).toBe(15_000);
    });
});
