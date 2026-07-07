import { describe, expect, test } from "bun:test";
import { CostTracker, stampUsageCost } from "../src/agent/cost";
import {
    addLedgerRow,
    attachLedgerEntry,
    auditLedger,
    getCostBaseline,
    sumLedgerForSession,
} from "../src/sessions/cost-ledger";
import { getDb } from "../src/sessions/db";
import { SessionManager } from "../src/sessions";
import type { UsageBlock } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

// xai/grok-build-0.1 catalog prices: input $1/MTok, output $2/MTok, cacheRead $0.2, cacheWrite $0
const MODEL = "xai/grok-build-0.1";

const usage = (input: number, output: number, extra: Partial<UsageBlock> = {}): UsageBlock => ({
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...extra,
});

async function makeSession(cwd = "/proj") {
    const mgr = new SessionManager();
    return mgr.create({ cwd, provider: "xai", model: MODEL });
}

/** Freeze a baseline the way the retired v0.9.0 cutover did — straight into meta. */
function setBaseline(snapshot: unknown) {
    getDb().run("INSERT OR REPLACE INTO meta (key, value) VALUES ('cost_baseline', ?)", [JSON.stringify(snapshot)]);
}

describe("cost ledger invariants (DESIGN.md §1b)", () => {
    test("invariant 1: live session total == reopened session total", async () => {
        const session = await makeSession();
        const tracker = new CostTracker();
        const ctx = { cwd: "/proj", sessionPub: session.info.id, source: "turn" as const };

        // Two billed steps + their persisted entries (as runTurn does).
        for (const u of [usage(1_000_000, 100_000), usage(500_000, 50_000)]) {
            tracker.add(MODEL, u, ctx);
            await session.append({
                type: "message",
                ts: Date.now(),
                role: "assistant",
                content: "step",
                usage: stampUsageCost(MODEL, u),
                model: MODEL,
            });
        }
        const live = tracker.sessionBreakdown();
        expect(live.usd).toBeCloseTo(1.2 + 0.6, 6); // (1M×$1 + 100k×$2) + (500k×$1 + 50k×$2)

        const mgr = new SessionManager();
        const reopened = await mgr.open(session.info.id);
        const fresh = new CostTracker();
        fresh.seedFromSession(reopened);
        const seeded = fresh.sessionBreakdown();
        expect(seeded.usd).toBeCloseTo(live.usd, 9);
        expect(seeded.inputTokens).toBe(live.inputTokens);
        expect(seeded.outputTokens).toBe(live.outputTokens);
    });

    test("invariant 1 covers estimated + non-turn sources: recap/compact spend survives reopen", async () => {
        const session = await makeSession();
        const tracker = new CostTracker();
        const pub = session.info.id;
        await session.append({ type: "message", ts: 1, role: "user", content: "hi" });

        tracker.add(MODEL, usage(100_000, 10_000), { sessionPub: pub, source: "turn" });
        tracker.add(MODEL, usage(20_000, 1_000), { sessionPub: pub, source: "recap" });
        tracker.add(MODEL, usage(30_000, 2_000), { sessionPub: pub, source: "compact" });
        tracker.addEstimated(MODEL, { ...usage(5_000, 500), estimated: true }, { sessionPub: pub, source: "turn" });
        const live = tracker.sessionBreakdown();
        expect(live.estimated).toBe(true);

        const fresh = new CostTracker();
        const mgr = new SessionManager();
        fresh.seedFromSession(await mgr.open(pub));
        const seeded = fresh.sessionBreakdown();
        expect(seeded.usd).toBeCloseTo(live.usd, 9);
        expect(seeded.estimated).toBe(true); // ~ prefix survives reopen
    });

    test("invariant 2: lifetime = baseline + SUM(estimated=0, backfilled=0)", async () => {
        setBaseline({
            lifetime: { usd: 10, byProvider: { anthropic: 10 } },
            daily: { "2026-01-01": 10 },
            byCwd: { "/old": 10 },
        });
        const session = await makeSession();
        const tracker = new CostTracker();
        const ctx = { cwd: "/proj", sessionPub: session.info.id, source: "turn" as const };
        tracker.add(MODEL, usage(1_000_000, 0), ctx); // $1 real
        tracker.addEstimated(MODEL, { ...usage(1_000_000, 0), estimated: true }, ctx); // $1 estimated — excluded

        const stats = tracker.stats("/proj");
        expect(stats.lifetimeUsd).toBeCloseTo(11, 6); // 10 baseline + 1 real
        expect(stats.byProvider.anthropic).toBeCloseTo(10, 6);
        expect(stats.byProvider.xai).toBeCloseTo(1, 6);
        // today includes only the real row; the estimated one never bills
        expect(stats.todayUsd).toBeCloseTo(1, 6);
        expect(stats.cwdUsd).toBeCloseTo(1, 6);
    });

    test("baseline daily buckets merge into today/7d/month views", async () => {
        const today = new Date().toLocaleDateString("sv");
        setBaseline({ lifetime: { usd: 5, byProvider: {} }, daily: { [today]: 5 }, byCwd: {} });
        const session = await makeSession();
        const tracker = new CostTracker();
        tracker.add(MODEL, usage(1_000_000, 0), { cwd: "/proj", sessionPub: session.info.id, source: "turn" });
        const stats = tracker.stats();
        expect(stats.todayUsd).toBeCloseTo(6, 6); // 5 frozen + 1 new
        expect(stats.last7Usd).toBeCloseTo(6, 6);
    });

    test("invariant 3: rows written by add() self-audit; a corrupted row is flagged", async () => {
        const session = await makeSession();
        const tracker = new CostTracker();
        tracker.add(MODEL, usage(1_000_000, 500_000, { inputTokenDetails: { cacheReadTokens: 200_000 } }), {
            cwd: "/proj",
            sessionPub: session.info.id,
            source: "turn",
        });
        expect(auditLedger().priceViolations).toHaveLength(0);

        getDb().run("UPDATE cost_ledger SET usd = usd + 1"); // tamper
        expect(auditLedger().priceViolations).toHaveLength(1);
    });

    test("invariant 4: ledger↔entries cross-check catches a divergent session", async () => {
        const session = await makeSession();
        const tracker = new CostTracker();
        const u = usage(100_000, 10_000);
        tracker.add(MODEL, u, { cwd: "/proj", sessionPub: session.info.id, source: "turn" });
        await session.append({
            type: "message",
            ts: Date.now(),
            role: "assistant",
            content: "x",
            usage: stampUsageCost(MODEL, u),
            model: MODEL,
        });
        expect(auditLedger().sessionMismatches).toHaveLength(0);

        // A ledger row the transcript never saw → mismatch.
        tracker.add(MODEL, usage(999, 0), { cwd: "/proj", sessionPub: session.info.id, source: "turn" });
        const audit = auditLedger();
        expect(audit.sessionMismatches).toHaveLength(1);
        expect(audit.sessionMismatches[0].sessionPub).toBe(session.info.id);
    });

    test("invariant 5: /steak dailyTokens excludes estimated usage", async () => {
        const session = await makeSession();
        await session.append({
            type: "message",
            ts: Date.now(),
            role: "assistant",
            content: "real",
            usage: usage(100, 10),
        });
        await session.append({
            type: "message",
            ts: Date.now(),
            role: "assistant",
            content: "guess",
            interrupted: true,
            usage: { ...usage(1_000_000, 0), estimated: true },
        });
        const mgr = new SessionManager();
        const daily = mgr.dailyTokens();
        // Bucket-key-agnostic: bun test pins TZ=UTC while SQLite 'localtime'
        // uses the OS zone, so "today" can differ inside tests. The assertion
        // is the exclusion itself: the estimated 1M never counts anywhere.
        const total = [...daily.values()].reduce((a, b) => a + b, 0);
        expect(total).toBe(110);
    });

    test("openrouter rows record provider_cost as the billed usd and skip the price check", async () => {
        const session = await makeSession();
        const tracker = new CostTracker();
        tracker.add("openrouter/x-ai/grok-build-0.1", usage(1_000_000, 0, { cost: 1.23 }), {
            sessionPub: session.info.id,
            source: "turn",
        });
        const sums = sumLedgerForSession(session.info.id);
        expect(sums.usd).toBeCloseTo(1.23, 6);
        expect(auditLedger().priceViolations).toHaveLength(0);
    });

    test("attachLedgerEntry links a row to its entry", async () => {
        const session = await makeSession();
        const entry = {
            type: "message" as const,
            ts: Date.now(),
            role: "assistant" as const,
            content: "x",
            usage: usage(10, 1),
        };
        await session.append(entry);
        const rowId = addLedgerRow({
            provider: "xai",
            model: MODEL,
            usage: usage(10, 1),
            usd: 0,
            ctx: { source: "turn", sessionPub: session.info.id },
        });
        attachLedgerEntry(rowId, (entry as { id?: string }).id!);
        const row = getDb()
            .query<{ entry_pub: string | null; entry_id: number | null }, [number]>(
                "SELECT entry_pub, entry_id FROM cost_ledger WHERE id = ?",
            )
            .get(rowId);
        expect(row?.entry_pub).toBe((entry as { id?: string }).id!);
        expect(row?.entry_id).not.toBeNull();
    });
});

describe("cost baseline (frozen at the retired v0.9.0 cutover)", () => {
    test("a corrupt stored snapshot degrades to a zero baseline", () => {
        setBaseline({ lifetime: { usd: Number.NaN, byProvider: { xai: "junk" } } });
        const b = getCostBaseline();
        expect(b.lifetime.usd).toBe(0);
        expect(b.lifetime.byProvider.xai).toBe(0);
    });
});
