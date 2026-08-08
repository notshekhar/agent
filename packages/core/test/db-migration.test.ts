import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { getDb, setDbPathForTests } from "../src/sessions/db";
import { getSessionStore } from "../src/sessions/sqlite-store";

// The v1 entries/meta schema, as shipped — no usage_usd column. Opening it
// with the current build must ALTER it in place (v1 → v2) without touching
// existing rows.
const V1_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pub_id TEXT NOT NULL UNIQUE,
    cwd TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    name TEXT, parent_pub TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    pub_id TEXT NOT NULL, parent_pub_id TEXT, ts INTEGER NOT NULL,
    type TEXT NOT NULL, role TEXT, payload TEXT NOT NULL,
    usage_input INTEGER, usage_output INTEGER, usage_total INTEGER,
    usage_no_cache INTEGER, usage_cache_read INTEGER, usage_cache_write INTEGER,
    usage_text INTEGER, usage_reasoning INTEGER, usage_estimated INTEGER,
    model TEXT,
    UNIQUE (session_id, pub_id)
);
CREATE TABLE cost_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, day TEXT NOT NULL,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    session_pub TEXT, source TEXT NOT NULL, cwd TEXT,
    provider TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, no_cache_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER,
    output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER,
    price_input REAL, price_output REAL, price_cache_read REAL, price_cache_write REAL,
    usd REAL NOT NULL, provider_cost REAL,
    estimated INTEGER NOT NULL DEFAULT 0, backfilled INTEGER NOT NULL DEFAULT 0
);
`;

describe("session db v1 → v2 migration", () => {
    let dir: string | null = null;
    afterEach(() => {
        setDbPathForTests(null);
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = null;
    });

    test("adds usage_usd to an existing v1 db and keeps its rows", () => {
        dir = mkdtempSync(join(tmpdir(), "loop-migrate-"));
        const path = join(dir, "agent.db");
        const v1 = new Database(path, { create: true });
        v1.exec(V1_SCHEMA);
        v1.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
        v1.run(
            `INSERT INTO sessions (pub_id, cwd, provider, model, created_at, updated_at)
             VALUES ('s1', '/tmp', 'xai', 'xai/grok-build-0.1', 0, 0)`,
        );
        v1.run(
            `INSERT INTO entries (session_id, pub_id, ts, type, role, payload, usage_input, usage_output)
             VALUES (1, 'e1', 0, 'message', 'assistant', '{"type":"message"}', 100, 10)`,
        );
        v1.close();

        setDbPathForTests(path);
        const db = getDb();
        const cols = db.query<{ name: string }, []>("PRAGMA table_info(entries)").all();
        expect(cols.map((c) => c.name)).toContain("usage_usd");
        const ledgerCols = db.query<{ name: string }, []>("PRAGMA table_info(cost_ledger)").all();
        expect(ledgerCols.map((c) => c.name)).toContain("entry_id");
        expect(ledgerCols.map((c) => c.name)).toContain("entry_pub");
        const version = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
        expect(version?.value).toBe("7");
        // v6 → v7: sessions.archived_at. A timestamp rather than a flag —
        // "when did I put this away" is what an archive list sorts by.
        const sessionCols = db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all();
        expect(sessionCols.map((c) => c.name)).toContain("archived_at");
        // A session that predates archiving is active, not archived.
        const existing = db
            .query<{ archived_at: number | null }, []>("SELECT archived_at FROM sessions WHERE pub_id = 's1'")
            .get();
        expect(existing?.archived_at).toBeNull();
        // v2 → v3 rides the same pass, as does v5 → v6 (projects.bash_allow).
        const projCols = db.query<{ name: string }, []>("PRAGMA table_info(projects)").all();
        expect(projCols.map((c) => c.name)).toContain("provider_models");
        expect(projCols.map((c) => c.name)).toContain("bash_allow");
        // v3 → v4 is a new table (goals), created by the schema exec; v4 → v5
        // adds goals.agent (a no-op ALTER here since the fresh table has it).
        const goalCols = db.query<{ name: string }, []>("PRAGMA table_info(goals)").all();
        expect(goalCols.map((c) => c.name)).toContain("last_run_session_id");
        expect(goalCols.map((c) => c.name)).toContain("agent");
        // Pre-migration rows survive with a NULL stamp (no backfill).
        const row = db
            .query<{ usage_input: number; usage_usd: number | null }, []>(
                "SELECT usage_input, usage_usd FROM entries WHERE pub_id = 'e1'",
            )
            .get();
        expect(row?.usage_input).toBe(100);
        expect(row?.usage_usd).toBeNull();
    });

    test("new inserts persist the usd stamp into the derived column", () => {
        dir = mkdtempSync(join(tmpdir(), "loop-usd-col-"));
        setDbPathForTests(join(dir, "agent.db"));
        const store = getSessionStore();
        const rowId = store.ensureSession({
            id: "s2",
            createdAt: 0,
            cwd: "/tmp",
            provider: "xai",
            model: "xai/grok-build-0.1",
        });
        store.appendEntries(rowId, [
            {
                type: "message",
                ts: 0,
                role: "assistant",
                content: "hi",
                id: "e1",
                usage: { inputTokens: 100, outputTokens: 10, usd: 0.1234, usdDetails: { input: 0.1, output: 0.0234 } },
            },
        ]);
        const row = getDb()
            .query<{ usage_usd: number | null; payload: string }, [number]>(
                "SELECT usage_usd, payload FROM entries WHERE session_id = ?",
            )
            .get(rowId);
        expect(row?.usage_usd).toBeCloseTo(0.1234, 6);
        // The split rides the payload (source of truth) — no extra columns.
        const usage = (JSON.parse(row!.payload) as { usage: { usdDetails?: { input?: number } } }).usage;
        expect(usage.usdDetails?.input).toBeCloseTo(0.1, 6);
    });
});

describe("clean-shutdown marker", () => {
    let dir: string | null = null;
    afterEach(() => {
        setDbPathForTests(null);
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = null;
    });

    const marker = () =>
        getDb().query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'clean_shutdown'").get()?.value;

    test("open marks the run dirty; closeDb marks it clean", () => {
        dir = mkdtempSync(join(tmpdir(), "loop-clean-"));
        const path = join(dir, "agent.db");
        setDbPathForTests(path);
        expect(marker()).toBe("0");
        // setDbPathForTests(path) closes via closeDb, then reopen reads the marker
        setDbPathForTests(path);
        const raw = new Database(path);
        const afterClose = raw
            .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'clean_shutdown'")
            .get();
        raw.close();
        expect(afterClose?.value).toBe("1");
        // and a fresh open flips it back to dirty for this run's duration
        expect(marker()).toBe("0");
    });
});
