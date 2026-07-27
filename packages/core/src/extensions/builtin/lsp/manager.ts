/**
 * Per-workspace owner of language-server processes. One manager per cwd (cached
 * as a module singleton), lazily spawning at most one server per (language,
 * project root) pair. A file can be served by several — a type checker and a
 * linter both answer for `.ts`, and their diagnostics are complementary — so
 * every lookup returns a list. Servers persist across edits and are torn down on
 * the extension's deactivate() (and as a safety net on process exit).
 */
import { LspClient } from "./client";
import type { Diagnostic } from "./protocol";
import { findRoot, resolveOrProvisionServer, serversFor } from "./servers";

const DIAGNOSTICS_TIMEOUT_MS = 1500;

/** A live client plus the registry key that produced it. */
export interface ActiveClient {
    key: string;
    client: LspClient;
}

export class LspManager {
    /** Keyed by `<serverKey>@<projectRoot>` so a monorepo gets one per package. */
    private readonly clients = new Map<string, Promise<LspClient | null>>();

    constructor(private readonly cwd: string) {}

    /** Every server that can serve this file, started on demand. */
    async clientsFor(absPath: string): Promise<ActiveClient[]> {
        const defs = serversFor(absPath, this.cwd);
        const started = await Promise.all(
            defs.map(async (def) => {
                const root = findRoot(def, absPath, this.cwd);
                const client = await this.clientFor(def.key, root);
                return client ? { key: def.key, client } : null;
            }),
        );
        return started.filter((c): c is ActiveClient => c !== null);
    }

    /** True when at least one server is available for this file. */
    async hasClients(absPath: string): Promise<boolean> {
        return (await this.clientsFor(absPath)).length > 0;
    }

    /** Diagnostics from every server that handles the file, merged. */
    async diagnose(absPath: string, content: string): Promise<Diagnostic[]> {
        const clients = await this.clientsFor(absPath);
        if (clients.length === 0) return [];
        const results = await Promise.all(
            clients.map(({ client }) =>
                client.diagnose(absPath, content, DIAGNOSTICS_TIMEOUT_MS).catch(() => [] as Diagnostic[]),
            ),
        );
        return results.flat();
    }

    private clientFor(key: string, root: string): Promise<LspClient | null> {
        const id = `${key}@${root}`;
        const cached = this.clients.get(id);
        if (cached) {
            return cached.then((c) => {
                // A crashed server is dropped and respawned on next use; a
                // server that never started stays null (cached as "broken").
                if (c && !c.isAlive) {
                    this.clients.delete(id);
                    return this.clientFor(key, root);
                }
                return c;
            });
        }
        const job = this.startServer(key, root);
        this.clients.set(id, job);
        return job;
    }

    private async startServer(key: string, root: string): Promise<LspClient | null> {
        const spec = await resolveOrProvisionServer(key, root);
        if (!spec) return null;
        const client = new LspClient(spec, root);
        try {
            await client.start();
        } catch {
            return null;
        }
        return client;
    }

    async shutdown(): Promise<void> {
        const clients = await Promise.all([...this.clients.values()]);
        await Promise.all(clients.map((c) => c?.shutdown()));
        this.clients.clear();
    }
}

const managers = new Map<string, LspManager>();
let exitHookInstalled = false;

export function getLspManager(cwd: string): LspManager {
    let mgr = managers.get(cwd);
    if (!mgr) {
        mgr = new LspManager(cwd);
        managers.set(cwd, mgr);
    }
    if (!exitHookInstalled) {
        exitHookInstalled = true;
        const cleanup = () => {
            for (const m of managers.values()) void m.shutdown();
        };
        process.on("exit", cleanup);
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
    }
    return mgr;
}

/** Shut down every manager — called from the extension's deactivate(). */
export async function shutdownAllManagers(): Promise<void> {
    const all = [...managers.values()];
    managers.clear();
    await Promise.all(all.map((m) => m.shutdown()));
}
