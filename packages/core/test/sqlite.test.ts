import { describe, expect, test } from "bun:test";

import { isBunRuntime, openSqlite, sleepSyncMs } from "../src/sessions/sqlite";

/**
 * The contract both runtimes must satisfy.
 *
 * This file runs under Bun, so it exercises the `bun:sqlite` path — the one
 * the CLI ships. The Node path cannot be reached from here at all (Bun has no
 * `node:sqlite` built-in), so it is verified by `scripts/verify-node-runtime.ts`
 * against Electron's Node instead. Keep the two in step: anything asserted
 * here should be asserted there.
 */
describe("the sqlite handle", () => {
    test("hands back the real bun:sqlite Database under Bun", () => {
        // Not a wrapper: the CLI's behaviour — corruption recovery, timing,
        // every quirk — has to be exactly what it was before the adapter.
        expect(isBunRuntime()).toBe(true);
        const db = openSqlite(":memory:");
        expect(db.constructor.name).toBe("Database");
        db.close();
    });

    test("supports everything core actually calls", () => {
        const db = openSqlite(":memory:");
        db.exec("CREATE TABLE t (a TEXT, b INTEGER)");

        const insert = db.query("INSERT INTO t VALUES (?, ?)");
        const inserted = insert.run("x", 1);
        expect(Number(inserted.changes)).toBe(1);
        expect(Number(inserted.lastInsertRowid)).toBe(1);
        insert.run("y", 2);

        expect(db.query<{ a: string }>("SELECT a FROM t ORDER BY b").all()).toEqual([
            { a: "x" },
            { a: "y" },
        ]);
        expect(db.query<{ b: number }>("SELECT b FROM t WHERE a = ?").get("y")).toEqual({ b: 2 });
        expect([...db.query("SELECT a FROM t").iterate()]).toHaveLength(2);
        // Corruption salvage copies tables whose shape it cannot know.
        expect(db.query("SELECT * FROM t").columnNames).toEqual(["a", "b"]);
        db.close();
    });

    test("transaction() returns a callable rather than running immediately", () => {
        // Core relies on this shape: `const tx = db.transaction(...); tx();`
        const db = openSqlite(":memory:");
        db.exec("CREATE TABLE t (a TEXT)");
        let ran = false;
        const tx = db.transaction(() => {
            ran = true;
            db.query("INSERT INTO t VALUES (?)").run("in");
            return "done";
        });
        expect(ran).toBe(false);
        expect(tx()).toBe("done");
        expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
        db.close();
    });

    test("a throwing transaction leaves nothing behind", () => {
        const db = openSqlite(":memory:");
        db.exec("CREATE TABLE t (a TEXT)");
        db.query("INSERT INTO t VALUES (?)").run("before");
        const tx = db.transaction(() => {
            db.query("INSERT INTO t VALUES (?)").run("during");
            throw new Error("nope");
        });
        expect(tx).toThrow("nope");
        expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
        db.close();
    });

    test("the pragmas the session db depends on are accepted", () => {
        // WAL is how several loops share one file; foreign keys are what makes
        // `session.delete` cascade to entries.
        const db = openSqlite(":memory:");
        expect(() => db.exec("PRAGMA journal_mode = WAL")).not.toThrow();
        expect(() => db.exec("PRAGMA foreign_keys = ON")).not.toThrow();
        db.close();
    });

    test("sleepSyncMs actually blocks", () => {
        // It backs off a busy database open, so yielding instead of blocking
        // would let the retry interleave with the thing it is waiting on.
        const started = Date.now();
        sleepSyncMs(20);
        expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    });
});
