import { getDb } from "./db";

/**
 * The `projects` table — per-directory state that used to live in three
 * places (trust.json; the projectModels + projectProviderModels keys inside
 * settings.json). One row per canonical dir: trust decision, last model
 * pick, and the per-provider model map (JSON in provider_models).
 *
 * agent/trust.ts and the auth barrel keep their public surfaces; only the
 * persistence lines route here (DESIGN.md §2). Reads are direct prepared
 * SELECTs — called at startup/turn boundaries, never in a hot loop, and a
 * live query is what makes two concurrent loops see each other's decisions.
 */

function upsert(dir: string, fields: { trust?: boolean; model?: string; providerModels?: Record<string, string> }) {
    const db = getDb();
    db.run(
        `INSERT INTO projects (dir, trust, model, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(dir) DO UPDATE SET
            trust = COALESCE(excluded.trust, projects.trust),
            model = COALESCE(excluded.model, projects.model),
            updated_at = excluded.updated_at`,
        [dir, fields.trust === undefined ? null : fields.trust ? 1 : 0, fields.model ?? null, Date.now()],
    );
    if (fields.providerModels !== undefined) {
        db.run("UPDATE projects SET provider_models = ? WHERE dir = ?", [JSON.stringify(fields.providerModels), dir]);
    }
}

// --------------------------------------------------------------------------
// Trust
// --------------------------------------------------------------------------

export function writeTrustRow(dir: string, decision: boolean): void {
    upsert(dir, { trust: decision });
}

/** All dirs with a decided trust value — the ancestor walk's snapshot. */
export function allTrustRows(): Map<string, boolean> {
    const rows = getDb()
        .query<{ dir: string; trust: number }, []>("SELECT dir, trust FROM projects WHERE trust IS NOT NULL")
        .all();
    return new Map(rows.map((r) => [r.dir, r.trust === 1]));
}

// --------------------------------------------------------------------------
// Per-project model memory
// --------------------------------------------------------------------------

/**
 * Per-project model memory: the last model picked while working in a folder
 * is restored next time loop starts there. Global defaultModel stays the
 * fallback for folders never seen before.
 */
export function getProjectModel(cwd: string): string | undefined {
    const row = getDb().query<{ model: string | null }, [string]>("SELECT model FROM projects WHERE dir = ?").get(cwd);
    return row?.model || undefined;
}

export function setProjectModel(cwd: string, modelId: string): void {
    upsert(cwd, { model: modelId });
    // Also remember the pick per provider, so switching providers and back
    // restores the model used last with that provider in this folder.
    const provider = providerOfModelId(modelId);
    if (!provider) return;
    const current = readProviderModels(cwd);
    upsert(cwd, { providerModels: { ...current, [provider]: modelId } });
}

/**
 * Last model used with a given provider in this folder. Lets /provider
 * restore the model you had with that provider instead of its first model.
 */
export function getProjectProviderModel(cwd: string, provider: string): string | undefined {
    const id = readProviderModels(cwd)[provider];
    return typeof id === "string" && id ? id : undefined;
}

function readProviderModels(cwd: string): Record<string, string> {
    const row = getDb()
        .query<{ provider_models: string | null }, [string]>("SELECT provider_models FROM projects WHERE dir = ?")
        .get(cwd);
    if (!row?.provider_models) return {};
    try {
        const parsed = JSON.parse(row.provider_models) as Record<string, string>;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

// --------------------------------------------------------------------------
// Per-project bash "always allow" grants
// --------------------------------------------------------------------------

/**
 * Interactive "always allow" grants from the bash approval prompt, scoped to
 * the project (exact canonical dir) they were made in — a grant in one repo
 * never applies in another. Same pattern shape as bashDeny/bashAllow. The
 * legacy global settings.bashAllow keeps working; matching consults both.
 */
export function getProjectBashAllow(cwd: string): string[] {
    const row = getDb()
        .query<{ bash_allow: string | null }, [string]>("SELECT bash_allow FROM projects WHERE dir = ?")
        .get(cwd);
    if (!row?.bash_allow) return [];
    try {
        const parsed = JSON.parse(row.bash_allow) as unknown;
        return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
    } catch {
        return [];
    }
}

export function setProjectBashAllow(cwd: string, patterns: string[]): void {
    upsert(cwd, {});
    getDb().run("UPDATE projects SET bash_allow = ?, updated_at = ? WHERE dir = ?", [
        JSON.stringify(patterns),
        Date.now(),
        cwd,
    ]);
}

/** Append grants (deduped) to the project's always-allow list. */
export function addProjectBashAllow(cwd: string, patterns: string[]): void {
    const current = getProjectBashAllow(cwd);
    const next = [...current, ...patterns.filter((p) => !current.includes(p))];
    if (next.length !== current.length) setProjectBashAllow(cwd, next);
}

// Mirrors providers/parseModelId; inlined (and non-throwing) to avoid a
// sessions ↔ providers import cycle.
function providerOfModelId(modelId: string): string | undefined {
    const start = modelId.startsWith("custom:") ? "custom:".length : 0;
    const idx = modelId.indexOf("/", start);
    return idx > 0 ? modelId.slice(0, idx) : undefined;
}
