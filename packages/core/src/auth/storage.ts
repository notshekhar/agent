import Configstore from "configstore";
import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir, LEGACY_CONFIG_DIR_NAMES, PRODUCT_NAME } from "../brand";

const CONFIG_DIR = getConfigDir();

/**
 * One-time migration of a legacy config dir, for installs that don't go
 * through install.sh/install.ps1 (npm, source, bun link). MOVE the newest
 * existing legacy dir (e.g. ~/.pi) into the current config dir (copy, then
 * delete the old dir only once the copy succeeds) so config is never lost or
 * duplicated across product renames. No-op once the current dir exists.
 *
 * Called explicitly from the CLI entrypoint (not at module load) so it never
 * fires during tests, which import this module against the real home dir.
 */
export function migrateLegacyConfig(): void {
    try {
        if (existsSync(CONFIG_DIR)) return;
        // Newest legacy name first (LEGACY_CONFIG_DIR_NAMES is ordered oldest last).
        const legacy = LEGACY_CONFIG_DIR_NAMES.map((name) => join(homedir(), name)).find((dir) => existsSync(dir));
        if (!legacy) return;
        cpSync(legacy, CONFIG_DIR, { recursive: true });
        // Only remove the legacy dir once the copy has landed.
        if (existsSync(CONFIG_DIR)) rmSync(legacy, { recursive: true, force: true });
    } catch {
        // Best-effort: a failed copy/delete leaves the legacy dir intact, and the
        // app simply starts with whatever config is present rather than crashing.
    }
}

type StoreData = Record<string, unknown>;

/**
 * configstore reads + JSON-parses the whole file from disk on EVERY `.get`/`.all`
 * and rewrites it on every `.set` — it has no in-memory cache (verified against
 * configstore@7 source: `get all()` calls `readFileSync` each time). In our hot
 * paths that synchronous read blocks the event loop: the agent loop reads ~8
 * settings per turn (plus per subagent), and the footer ticker reads several
 * every second. That blocking I/O is a prime suspect for the UI freezing.
 *
 * CachedStore keeps the parsed object in memory and only touches the disk on a
 * real write. Reads come from the cache; writes go through to configstore (for
 * persistence) and refresh the cache. `refresh()` drops the cache so an external
 * edit to the file is picked up on the next read.
 */
export class CachedStore {
    // Constructed lazily: Configstore writes its defaults file in the
    // constructor, and these stores are module-level singletons — an eager
    // construct would create the config dir at import time, before the CLI
    // entrypoint has run migrateLegacyConfig() (which skips itself when the
    // dir already exists). No disk I/O until a store is actually used.
    private _store: Configstore | null = null;
    private cache: StoreData | null = null;

    constructor(
        private readonly id: string,
        private readonly defaults: StoreData,
        private readonly options: { configPath: string },
    ) {}

    private get store(): Configstore {
        if (this._store === null) this._store = new Configstore(this.id, this.defaults, this.options);
        return this._store;
    }

    get all(): StoreData {
        if (this.cache === null) this.cache = this.store.all as StoreData;
        return this.cache;
    }

    set all(value: StoreData) {
        this.store.all = value;
        this.cache = value;
    }

    get(key: string): unknown {
        return this.all[key];
    }

    set(key: string, value: unknown): void {
        this.store.set(key, value);
        // Keep the cache coherent without a re-read. If nothing is cached yet,
        // leave it null so the next read pulls the merged-with-defaults file.
        if (this.cache !== null) this.cache[key] = value;
    }

    delete(key: string): void {
        this.store.delete(key);
        if (this.cache !== null) delete this.cache[key];
    }

    /** Force a re-read on next access — call after an external write to the file. */
    refresh(): void {
        this.cache = null;
    }
}

export const authStore = new CachedStore(
    `${PRODUCT_NAME}-agent-auth`,
    { providers: {}, active: null },
    { configPath: join(CONFIG_DIR, "auth.json") },
);

export const settingsStore = new CachedStore(
    `${PRODUCT_NAME}-agent-settings`,
    {
        defaultModel: null,
        theme: "dark",
        maxSteps: 0, // 0 = unlimited; loop ends when the model stops calling tools
        autoCompactThreshold: 0.8,
        workspaceContext: true,
    },
    { configPath: join(CONFIG_DIR, "settings.json") },
);

// Datasources for the data-analyst agent's `sql` tool. Kept in its own file
// (not settings.json) so connection configs stay isolated from app settings.
export const datasourcesStore = new CachedStore(
    `${PRODUCT_NAME}-agent-datasources`,
    { connections: {} },
    { configPath: join(CONFIG_DIR, "datasources.json") },
);

// getProjectModel/setProjectModel/getProjectProviderModel moved to
// sessions/projects.ts (the projects table); the auth barrel re-exports them
// so the public surface is unchanged.
