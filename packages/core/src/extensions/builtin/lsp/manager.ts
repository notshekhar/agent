/**
 * Per-workspace owner of language-server processes. One manager per cwd (cached
 * as a module singleton), lazily spawning at most one server per (language,
 * project root) pair. A file can be served by several — a type checker and a
 * linter both answer for `.ts`, and their diagnostics are complementary — so
 * every lookup returns a list. Servers persist across edits and are torn down on
 * the extension's deactivate() (and as a safety net on process exit).
 */
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { LspClient } from "./client";
import type { Diagnostic } from "./protocol";
import { findRoot, languageKeysFor, resolveOrProvisionServer, serversFor } from "./servers";

const DIAGNOSTICS_TIMEOUT_MS = 1500;
/** Directories never worth walking to work out what a project is written in. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", ".next", "__pycache__"]);
/** Bounds on the directory scan — this runs on a tool call, not a build. */
const SCAN_MAX_ENTRIES = 400;
const SCAN_MAX_DEPTH = 3;

/**
 * One representative file per language found under `dir` — enough to decide
 * which servers a project needs, without walking the whole tree. Breadth-first
 * so top-level files (which characterise a project best) win, and bounded so a
 * huge repo costs the same as a small one.
 */
export function sampleFiles(dir: string): string[] {
    const picked = new Map<string, string>(); // extension → first file seen
    const queue: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];
    let seen = 0;
    while (queue.length > 0 && seen < SCAN_MAX_ENTRIES) {
        const { path, depth } = queue.shift()!;
        let entries: import("node:fs").Dirent[];
        try {
            entries = readdirSync(path, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (++seen > SCAN_MAX_ENTRIES) break;
            const full = join(path, entry.name);
            if (entry.isDirectory()) {
                if (depth < SCAN_MAX_DEPTH && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
                    queue.push({ path: full, depth: depth + 1 });
                }
                continue;
            }
            // Key by extension (or the bare name, for Dockerfile and friends).
            const key = extname(entry.name).toLowerCase() || entry.name.toLowerCase();
            if (picked.has(key)) continue;
            if (languageKeysFor(full).length > 0) picked.set(key, full);
        }
    }
    return [...picked.values()];
}

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

    /**
     * Servers for a path that may be a FILE or a DIRECTORY.
     *
     * `workspaceSymbol` asks about a whole project, so a directory — or the
     * repo root — is the natural thing to name, and the model does exactly
     * that. Matching servers by file extension finds nothing for a directory,
     * which read as "no language server available" for a project that has one.
     * For a directory we look inside for files a server handles and start those.
     */
    async clientsForTarget(absPath: string): Promise<ActiveClient[]> {
        let isDir = false;
        try {
            isDir = statSync(absPath).isDirectory();
        } catch {
            return this.clientsFor(absPath); // missing path — let the file path report it
        }
        if (!isDir) return this.clientsFor(absPath);

        const byKey = new Map<string, ActiveClient>();
        for (const sample of sampleFiles(absPath)) {
            for (const active of await this.clientsFor(sample)) {
                if (byKey.has(active.key)) continue;
                byKey.set(active.key, active);
                // Open the sample so the server actually loads the project. A
                // tsserver-style server builds its program from opened
                // documents, so workspace/symbol against a freshly started
                // server with nothing open returns an empty index.
                await active.client.openDocument(sample);
            }
        }
        return [...byKey.values()];
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
