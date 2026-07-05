import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/**
 * The DESIGN.md P4 gate: two real OS processes writing one WAL DB through the
 * production open path (busy_timeout → WAL → schema, bounded init retry) must
 * lose nothing — including the first-ever WAL switch on a FRESH file, the one
 * race busy_timeout doesn't reliably cover (foundation #3).
 */

const WORKER = `
import { setDbPathForTests, getDb } from "../src/sessions/db";

const [path, tag, countStr] = process.argv.slice(2);
setDbPathForTests(path); // production openDb, minus the real-store migrations
const db = getDb();
const count = Number(countStr);
const insert = db.query(
    "INSERT INTO cost_ledger (ts, day, source, provider, model, input_tokens, output_tokens, usd) VALUES (?, ?, 'turn', ?, 'm', 1, 1, 0.01)",
);
for (let i = 0; i < count; i++) {
    // One transaction per insert = maximum lock contention.
    db.transaction(() => insert.run(Date.now(), "2026-01-01", tag))();
}
process.exit(0);
`;

describe("two-process WAL concurrency", () => {
    test("2 × 250 transactional inserts on a fresh file → 500 rows, integrity ok", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-2proc-"));
        const dbPath = join(dir, "loop.db");
        const workerPath = join(dir, "worker.ts");
        // The worker imports the production db module by absolute path.
        writeFileSync(workerPath, WORKER.replace("../src/sessions/db", join(import.meta.dir, "../src/sessions/db.ts")));

        try {
            const spawn = (tag: string) =>
                Bun.spawn(["bun", workerPath, dbPath, tag, "250"], { stdout: "pipe", stderr: "pipe" });
            const [a, b] = [spawn("A"), spawn("B")];
            const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
            if (codeA !== 0) console.error(await new Response(a.stderr).text());
            if (codeB !== 0) console.error(await new Response(b.stderr).text());
            expect(codeA).toBe(0);
            expect(codeB).toBe(0);

            const db = new Database(dbPath, { readonly: true });
            const rows = db
                .query<{ provider: string; n: number }, []>(
                    "SELECT provider, COUNT(*) AS n FROM cost_ledger GROUP BY provider ORDER BY provider",
                )
                .all();
            expect(rows).toEqual([
                { provider: "A", n: 250 },
                { provider: "B", n: 250 },
            ]);
            const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
            expect(integrity?.integrity_check).toBe("ok");
            db.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
