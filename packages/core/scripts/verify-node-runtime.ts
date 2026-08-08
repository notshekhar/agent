/**
 * Proves core runs on Node, not just Bun.
 *
 * The desktop app uses core as a LIBRARY from Electron's main process, which
 * is Node — so `bun:sqlite` is unavailable there and `sessions/sqlite.ts`
 * swaps in a `node:sqlite` adapter. `bun test` cannot cover that path at all
 * (Bun has no `node:sqlite` built-in), so this is the other half of
 * `test/sqlite.test.ts` and the two should be kept in step.
 *
 * Run it:
 *
 *   bun build packages/core/scripts/verify-node-runtime.ts \
 *     --target node --format cjs --outfile /tmp/verify.cjs
 *   ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/.bin/electron /tmp/verify.cjs
 *
 * It writes to a throwaway HOME, so it never touches a real session database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isBunRuntime, openSqlite, sleepSyncMs } from "../src/sessions/sqlite";

let failures = 0;

function check(what: string, actual: unknown, expected: unknown): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures += 1;
    console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

const home = mkdtempSync(join(tmpdir(), "loop-node-verify-"));
try {
    console.log(`runtime: ${isBunRuntime() ? "bun" : "node"}`);

    const db = openSqlite(join(home, "probe.db"));
    db.exec("CREATE TABLE t (a TEXT, b INTEGER)");

    const insert = db.query("INSERT INTO t VALUES (?, ?)");
    const inserted = insert.run("x", 1);
    check("run() reports changes", Number(inserted.changes), 1);
    check("run() reports lastInsertRowid", Number(inserted.lastInsertRowid), 1);
    insert.run("y", 2);

    check("all()", db.query("SELECT a FROM t ORDER BY b").all(), [{ a: "x" }, { a: "y" }]);
    check("get() with a param", db.query("SELECT b FROM t WHERE a = ?").get("y"), { b: 2 });
    check("iterate()", [...db.query("SELECT a FROM t").iterate()].length, 2);
    check("columnNames", db.query("SELECT * FROM t").columnNames, ["a", "b"]);

    // The shape core relies on: transaction() returns a callable.
    let ran = false;
    const tx = db.transaction(() => {
        ran = true;
        db.query("INSERT INTO t VALUES (?, ?)").run("z", 3);
        return "done";
    });
    check("transaction() does not run immediately", ran, false);
    check("transaction() returns the value", tx(), "done");
    check("transaction() committed", db.query("SELECT count(*) AS n FROM t").get(), { n: 3 });

    const failing = db.transaction(() => {
        db.query("INSERT INTO t VALUES (?, ?)").run("rolled", 4);
        throw new Error("nope");
    });
    try {
        failing();
        check("throwing transaction rethrows", "no throw", "threw");
    } catch {
        check("throwing transaction rolled back", db.query("SELECT count(*) AS n FROM t").get(), {
            n: 3,
        });
    }

    check("WAL pragma", (() => { db.exec("PRAGMA journal_mode = WAL"); return "ok"; })(), "ok");
    check("foreign_keys pragma", (() => { db.exec("PRAGMA foreign_keys = ON"); return "ok"; })(), "ok");

    const started = Date.now();
    sleepSyncMs(20);
    check("sleepSyncMs blocks", Date.now() - started >= 15, true);

    db.close();
} finally {
    rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
