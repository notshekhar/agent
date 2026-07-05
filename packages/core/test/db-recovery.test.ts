import { Database } from "bun:sqlite";
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { getDb, setDbPathForTests } from "../src/sessions/db";
import { getSessionStore } from "../src/sessions/sqlite-store";

/**
 * Corruption recovery: a db that fails quick_check on open is set aside as
 * loop.db.corrupt-<ts>, a fresh db takes its path, and every readable row is
 * salvaged into it. The test db is an injected path, so getDb()'s JSONL
 * re-import never runs — everything asserted here came through the salvage.
 */
describe("session db corruption recovery", () => {
    let dir: string | null = null;
    afterEach(() => {
        setDbPathForTests(null);
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = null;
    });

    /** Build a store with enough entry pages that mid-file damage can't hit them all. */
    function seed(path: string): void {
        setDbPathForTests(path);
        const store = getSessionStore();
        const rowId = store.ensureSession({
            id: "s-recover",
            createdAt: 0,
            cwd: "/tmp",
            provider: "xai",
            model: "xai/grok-build-0.1",
        });
        const fat = "x".repeat(2048);
        for (let i = 0; i < 50; i++) {
            store.appendEntries(rowId, [
                { type: "message", ts: i, role: "user", content: fat, id: `e${i}` },
            ]);
        }
        getDb().run("INSERT OR REPLACE INTO meta (key, value) VALUES ('cost_baseline', '{\"lifetime\":{\"usd\":42}}')");
        // Release the handle (marks clean_shutdown='1', checkpoints the WAL)…
        setDbPathForTests(null);
        // …then force the next open to verify, as a crashed run would.
        const raw = new Database(path);
        raw.run("UPDATE meta SET value = '0' WHERE key = 'clean_shutdown'");
        raw.close();
    }

    /** Zero a stretch of pages in the middle of the file — header stays valid,
     * quick_check fails. */
    function corrupt(path: string): void {
        const size = statSync(path).size;
        const fd = openSync(path, "r+");
        writeSync(fd, Buffer.alloc(8192), 0, 8192, Math.floor(size / 2));
        closeSync(fd);
    }

    test("sets the damaged file aside, salvages readable rows, stamps recovered_at", () => {
        dir = mkdtempSync(join(tmpdir(), "loop-recover-"));
        const path = join(dir, "loop.db");
        seed(path);
        corrupt(path);

        setDbPathForTests(path);
        const db = getDb();

        // The damaged original is preserved beside the fresh db.
        const corpses = readdirSync(dir).filter((f) => /^loop\.db\.corrupt-\d+$/.test(f));
        expect(corpses.length).toBe(1);

        // Recovery is stamped, and the fresh db passes verification.
        const recovered = db
            .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'recovered_at'")
            .get();
        expect(recovered).not.toBeNull();
        expect(db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check).toBe("ok");

        // The session row (early page) and a good chunk of entries survive.
        const session = getSessionStore().getSession("s-recover");
        expect(session).not.toBeNull();
        const entryCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM entries").get()!.n;
        expect(entryCount).toBeGreaterThan(0);

        // The frozen pre-ledger baseline is carried over; migration markers are
        // NOT, so the real store would re-import retained JSONL to fill gaps.
        const baseline = db
            .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'cost_baseline'")
            .get();
        expect(baseline?.value).toContain("42");
        const migrated = db
            .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'migrated_at'")
            .get();
        expect(migrated).toBeNull();

        // The recovered store keeps working.
        const rowId = getSessionStore().ensureSession({
            id: "s-after",
            createdAt: 1,
            cwd: "/tmp",
            provider: "xai",
            model: "xai/grok-build-0.1",
        });
        getSessionStore().appendEntries(rowId, [{ type: "message", ts: 1, role: "user", content: "hi", id: "post" }]);
        expect(getSessionStore().getSession("s-after")).not.toBeNull();
    });

    test("an intact dirty db verifies and opens in place — no recovery", () => {
        dir = mkdtempSync(join(tmpdir(), "loop-norecover-"));
        const path = join(dir, "loop.db");
        seed(path);

        setDbPathForTests(path);
        const db = getDb();
        expect(readdirSync(dir).filter((f) => f.includes("corrupt")).length).toBe(0);
        const recovered = db
            .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'recovered_at'")
            .get();
        expect(recovered).toBeNull();
        expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM entries").get()!.n).toBe(50);
    });
});
