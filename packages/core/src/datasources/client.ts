/**
 * Connection handling for datasources. One lazily-created pool per
 * connectionId, reused across the session and invalidated when its config
 * changes (saveDatasource/deleteDatasource call closePool) or on app exit
 * (closeAllPools). The `sql` tool never touches connections directly — it calls
 * runReadOnlyQuery and lets this module own the whole lifecycle.
 *
 * Layer 2 read-only guard: every query runs inside a READ ONLY transaction that
 * is always rolled back, so the database engine itself rejects any write — even
 * one hidden inside a CTE or a side-effecting function that Layer 1's static
 * check (validate.ts) can't see.
 */
import type { SQL as SQLType } from "bun";
import { getDatasource, resolveDatasourceSecrets, type DataSourceConfig } from "./config";
import { assertReadOnly } from "./validate";

/**
 * Bun's SQL client, resolved on first use rather than at module load.
 *
 * This used to be a plain `import { SQL } from "bun"`, which is evaluated the
 * moment anything in the import graph is loaded — and `tools/sql.ts` pulls this
 * module in, so `runTurn` did too. Under Bun that is free; under **Node it is
 * fatal**, because there is no `bun` module, and it took the whole of core down
 * on load. Core is a library now (the desktop app embeds it in Electron's main
 * process), so a Bun-only capability has to fail when it is *used*, not when it
 * is imported.
 *
 * Datasources genuinely require Bun — `SQL` is Bun's own driver and there is no
 * Node equivalent wired up here — so the error says that plainly instead of
 * surfacing as `Cannot find module "bun"`.
 */
type SQL = SQLType;
/** Bun's SQL constructor options; `typeof SQL` is unavailable now that the
 * import is type-only. */
type SQLOptions = ConstructorParameters<typeof SQLType>[0];
let SQLCtor: (new (options: unknown) => SQLType) | null = null;

function requireSQL(): new (options: unknown) => SQLType {
    if (SQLCtor) return SQLCtor;
    const bun = (globalThis as { Bun?: unknown }).Bun;
    if (!bun) {
        throw new Error(
            "datasources need the Bun runtime (they use Bun's built-in SQL client) — run this from the loop CLI",
        );
    }
    // Computed specifier so a Node-targeted bundler does not try to resolve
    // "bun" at build time; see sessions/sqlite.ts for the same technique.
    const spec = "bun";
    SQLCtor = (require(spec) as { SQL: new (options: unknown) => SQLType }).SQL;
    return SQLCtor;
}

/** Small pool — a single agent runs queries mostly sequentially. */
const POOL_MAX = 2;

const pools = new Map<string, SQL>();

function buildOptions(config: DataSourceConfig): SQLOptions {
    const adapter = config.type === "mysql" ? "mysql" : "postgres";
    const options: Record<string, unknown> = {
        adapter,
        hostname: config.host,
        port: config.port,
        database: config.database,
        username: config.user,
        password: config.password,
        max: POOL_MAX,
        idleTimeout: 30,
        connectionTimeout: 10,
    };
    // Redshift mandates TLS, so always encrypt it regardless of the toggle;
    // postgres/mysql honor the user's ssl flag. The postgres adapter takes a
    // `tls` boolean/object; mysql takes an `ssl` mode string. We disable cert
    // verification (rejectUnauthorized: false) because managed-DB certs
    // (Redshift/RDS) don't chain to system CAs — this matches sslmode=require:
    // encrypted, but no CA/hostname check.
    const useTls = config.ssl || config.type === "redshift";
    if (useTls) {
        if (adapter === "mysql") options.ssl = "require";
        else options.tls = { rejectUnauthorized: false };
    }
    return options as SQLOptions;
}

function getPool(id: string, config: DataSourceConfig): SQL {
    const existing = pools.get(id);
    if (existing) return existing;
    const pool = new (requireSQL())(buildOptions(resolveDatasourceSecrets(config)));
    pools.set(id, pool);
    return pool;
}

/** Begin a rolled-back read-only transaction for this dialect. */
function beginReadOnly(type: DataSourceConfig["type"]): string {
    return type === "mysql" ? "START TRANSACTION READ ONLY" : "BEGIN READ ONLY";
}

/**
 * Validate (Layer 1) then run a query inside a rolled-back READ ONLY
 * transaction (Layer 2). Returns the result rows. Throws on validation
 * failure, an unknown datasource, or any database error — the `sql` tool lets
 * these surface as tool-errors.
 */
export async function runReadOnlyQuery(connectionId: string, query: string): Promise<unknown> {
    assertReadOnly(query);
    const config = getDatasource(connectionId);
    if (!config) {
        throw new Error(`unknown datasource: ${connectionId} — add it with /datasource`);
    }
    const pool = getPool(connectionId, config);
    const reserved = await pool.reserve();
    try {
        await reserved.unsafe(beginReadOnly(config.type));
        const rows = await reserved.unsafe(query);
        await reserved.unsafe("ROLLBACK");
        return rows;
    } catch (err) {
        await reserved.unsafe("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        reserved.release();
    }
}

export interface TestResult {
    ok: boolean;
    error?: string;
}

/** Hard ceiling for a test so an unreachable host can't hang the UI. */
const TEST_TIMEOUT_MS = 15_000;

/**
 * Test a (possibly unsaved) config with a throwaway connection — never touches
 * the pool cache, so testing draft credentials can't poison a live pool. Always
 * resolves within TEST_TIMEOUT_MS even if the connect/query hangs.
 */
export async function testConnection(config: DataSourceConfig): Promise<TestResult> {
    let sql: SQL | undefined;
    try {
        sql = new (requireSQL())(buildOptions(resolveDatasourceSecrets(config)));
        const probe = sql.unsafe("SELECT 1");
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`timed out after ${TEST_TIMEOUT_MS / 1000}s`)), TEST_TIMEOUT_MS),
        );
        await Promise.race([probe, timeout]);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
        await sql?.close({ timeout: 0 }).catch(() => {});
    }
}

/** Drop a cached pool so its next use reconnects with fresh config. */
export async function closePool(connectionId: string): Promise<void> {
    const pool = pools.get(connectionId);
    if (!pool) return;
    pools.delete(connectionId);
    await pool.close({ timeout: 0 }).catch(() => {});
}

/** Close every pool — call on app shutdown. */
export async function closeAllPools(): Promise<void> {
    const all = [...pools.values()];
    pools.clear();
    await Promise.all(all.map((p) => p.close({ timeout: 0 }).catch(() => {})));
}
