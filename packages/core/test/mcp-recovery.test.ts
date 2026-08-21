/**
 * What MCP does when things go wrong: a server that dies mid-session, a config
 * edited under a running process, a connect that fails after the handshake, a
 * delete that lands while a connect is in flight, and a login that doesn't
 * finish. Each of these was a bug — the connection stayed "ready" while the
 * process behind it was gone, `reconnect` re-used the config from memory, a
 * failed connect orphaned its child, a removed server came back, and a
 * cancelled re-authorization signed the user out.
 */
import { CONFIG_DIR_NAME } from "../src/brand";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connectServer, namespacedToolName } from "../src/mcp/client";
import { McpManager } from "../src/mcp/manager";
import { getSetting, setSetting } from "../src/settings";
import type { McpServerConfig } from "../src/mcp/config";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "fixtures", "mock-mcp-server.mjs");
const BROKEN_LIST = join(here, "fixtures", "mock-mcp-broken-list.mjs");

const stdio = (pidfile?: string): McpServerConfig => ({
    command: process.execPath,
    args: [MOCK],
    ...(pidfile ? { env: { MOCK_MCP_PIDFILE: pidfile } } : {}),
});

function project(servers: Record<string, McpServerConfig>): string {
    const root = mkdtempSync(join(tmpdir(), "loop-mcp-recovery-"));
    writeServers(root, servers);
    return root;
}

function writeServers(root: string, servers: Record<string, McpServerConfig>): void {
    mkdirSync(join(root, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(root, CONFIG_DIR_NAME, "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

function tempPidfile(): string {
    return join(mkdtempSync(join(tmpdir(), "loop-mcp-pid-")), "pid");
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let manager: McpManager | undefined;
let savedGlobal: unknown;
beforeEach(() => {
    savedGlobal = getSetting("mcpServers");
    setSetting("mcpServers", {});
});
afterEach(async () => {
    await manager?.close();
    manager = undefined;
    setSetting("mcpServers", savedGlobal as Record<string, McpServerConfig> | undefined);
});

describe("a server that dies mid-session", () => {
    test("stops being ready and withdraws its tools", async () => {
        const pidfile = tempPidfile();
        manager = new McpManager();
        await manager.init(project({ mock: stdio(pidfile) }));
        expect(manager.listServers()[0]).toMatchObject({ status: "ready", toolCount: 2 });

        process.kill(Number(readFileSync(pidfile, "utf8")), "SIGKILL");
        await wait(500);

        // The model must not be offered tools whose server is gone.
        expect(manager.listServers()[0].status).toBe("error");
        expect(manager.listServers()[0].error).toMatch(/disconnected/);
        expect(Object.keys(manager.getTools())).toEqual([]);
    });
});

describe("reconnect", () => {
    test("re-reads the config from disk instead of the copy in memory", async () => {
        const root = project({ mock: stdio() });
        manager = new McpManager();
        await manager.init(root);

        // The user fixes one server and adds another, then hits /mcp reconnect.
        writeServers(root, {
            mock: { command: process.execPath, args: [MOCK, "--edited"] },
            extra: stdio(),
        });
        await manager.init(root); // no-op once initialized, as at the call site
        await manager.reconnect();

        const byName = Object.fromEntries(manager.listServers().map((s) => [s.name, s]));
        expect(Object.keys(byName).sort()).toEqual(["extra", "mock"]);
        expect((byName.mock.config as { args: string[] }).args).toContain("--edited");
        expect(byName.extra.status).toBe("ready");
    });

    test("drops a server that has been deleted from the file", async () => {
        const root = project({ mock: stdio(), doomed: stdio() });
        manager = new McpManager();
        await manager.init(root);
        expect(manager.listServers()).toHaveLength(2);

        writeServers(root, { mock: stdio() });
        await manager.reconnect();

        expect(manager.listServers().map((s) => s.name)).toEqual(["mock"]);
        expect(Object.keys(manager.getTools()).every((t) => t.startsWith("mcp__mock__"))).toBe(true);
    });
});

describe("a connect that fails after the handshake", () => {
    test("does not leave the subprocess behind", async () => {
        const pidfile = tempPidfile();
        await expect(
            connectServer("broken", {
                command: process.execPath,
                args: [BROKEN_LIST],
                env: { MOCK_MCP_PIDFILE: pidfile },
            }),
        ).rejects.toThrow();
        await wait(500);

        const pid = Number(readFileSync(pidfile, "utf8"));
        const alive = isAlive(pid);
        if (alive) process.kill(pid, "SIGKILL");
        expect(alive).toBe(false);
    });
});

describe("a delete that lands while the connect is in flight", () => {
    test("does not resurrect the server", async () => {
        manager = new McpManager();
        const connecting = manager.adopt("mock", stdio());
        await manager.remove("mock");
        await connecting;

        expect(manager.listServers()).toEqual([]);
        expect(Object.keys(manager.getTools())).toEqual([]);
    });
});

describe("tool names", () => {
    test("stay inside the 64-character limit providers enforce", () => {
        const name = namespacedToolName("atlassian-remote-mcp-server", "getConfluenceSpaceContentPagesWithAncestors");
        expect(name.length).toBeLessThanOrEqual(64);
        expect(name).toMatch(/^mcp__atlassian_remote_mcp_server__/);
        expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    });

    test("are unchanged when they already fit", () => {
        expect(namespacedToolName("fs", "read_file")).toBe("mcp__fs__read_file");
    });
});

describe("two servers whose names collide once sanitized", () => {
    test("the second is refused instead of silently overwriting the first", async () => {
        manager = new McpManager();
        await manager.init(project({ "my-fs": stdio(), "my.fs": stdio() }));

        const statuses = manager.listServers().map((s) => s.status);
        expect(statuses).toContain("ready");
        expect(statuses).toContain("error");
        expect(manager.listServers().find((s) => s.status === "error")?.error).toMatch(/collides/);
        // The one that did connect keeps a complete tool set.
        expect(Object.keys(manager.getTools()).sort()).toEqual(["mcp__my_fs__echo", "mcp__my_fs__structured"]);
    });
});

describe("a re-authorization that does not complete", () => {
    test("leaves the existing session in place", async () => {
        const { McpOAuthProvider, hasStoredTokens, clearMcpAuth } = await import("../src/mcp/oauth");
        const { authorizeServer } = await import("../src/mcp/authorize");
        const server = `test-reauth-${Date.now()}`;
        clearMcpAuth(server);
        new McpOAuthProvider(server, "http://127.0.0.1:8976/callback").saveTokens({
            access_token: "still-valid",
            token_type: "bearer",
        });

        // Dead port: discovery and the first auth() pass both fail.
        await authorizeServer(server, { type: "http", url: "http://127.0.0.1:9/mcp" }, () => {}).catch(() => {});

        const survived = hasStoredTokens(server);
        clearMcpAuth(server);
        expect(survived).toBe(true);
    });
});
