import { describe, expect, test } from "bun:test";
import { Semaphore } from "../src/agent/subagent";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Semaphore — parallel task fan-out gate", () => {
    test("under the limit, acquires resolve immediately", async () => {
        const s = new Semaphore(2);
        await s.acquire();
        await s.acquire();
        expect(s.queued).toBe(0);
    });

    test("over the limit, acquires queue and release wakes them FIFO", async () => {
        const s = new Semaphore(1);
        await s.acquire();
        const order: number[] = [];
        const a = s.acquire().then(() => order.push(1));
        const b = s.acquire().then(() => order.push(2));
        await tick();
        expect(s.queued).toBe(2);
        expect(order).toEqual([]);

        s.release();
        await a;
        expect(order).toEqual([1]);
        s.release();
        await b;
        expect(order).toEqual([1, 2]);
    });

    test("limit 0 = unlimited", async () => {
        const s = new Semaphore(0);
        for (let i = 0; i < 20; i++) await s.acquire();
        expect(s.queued).toBe(0);
        expect(s.tryAcquire()).toBe(true);
    });

    test("tryAcquire takes a free slot and refuses a full gate", () => {
        const s = new Semaphore(1);
        expect(s.tryAcquire()).toBe(true);
        expect(s.tryAcquire()).toBe(false);
        s.release();
        expect(s.tryAcquire()).toBe(true);
    });

    test("abort resolves a queued waiter without giving it a real slot", async () => {
        const s = new Semaphore(1);
        await s.acquire();
        const ctrl = new AbortController();
        let resolved = false;
        const queued = s.acquire(ctrl.signal).then(() => (resolved = true));
        await tick();
        expect(resolved).toBe(false);

        ctrl.abort();
        await queued;
        expect(resolved).toBe(true);
        // The aborted waiter left the queue: the caller's symmetric release
        // (finally) plus the holder's release leave the gate fully open.
        s.release(); // aborted caller unwinds
        s.release(); // original holder finishes
        expect(s.tryAcquire()).toBe(true);
        expect(s.tryAcquire()).toBe(false);
    });

    test("an aborted waiter is skipped by release — a later waiter still wakes", async () => {
        const s = new Semaphore(1);
        await s.acquire();
        const ctrl = new AbortController();
        const aborted = s.acquire(ctrl.signal);
        let laterRan = false;
        const later = s.acquire().then(() => (laterRan = true));
        await tick();
        expect(s.queued).toBe(2);

        ctrl.abort();
        await aborted;
        s.release(); // the aborted caller's finally
        await tick();
        expect(s.queued).toBe(0); // abort removed its waiter; release woke the later one

        await later;
        expect(laterRan).toBe(true);
    });

    test("concurrency never exceeds the limit under a fan-out burst", async () => {
        const LIMIT = 3;
        const s = new Semaphore(LIMIT);
        let running = 0;
        let peak = 0;
        const work = async () => {
            await s.acquire();
            try {
                running++;
                peak = Math.max(peak, running);
                await tick();
                await tick();
            } finally {
                running--;
                s.release();
            }
        };
        await Promise.all(Array.from({ length: 12 }, work));
        expect(peak).toBe(LIMIT);
        expect(running).toBe(0);
        expect(s.queued).toBe(0);
    });
});
