/**
 * Tool keys, and the things that quietly went missing when two of them landed
 * on the same string. A key is the only handle anyone has on an MCP tool: the
 * model calls it by name, the manager withdraws a dead server's tools by its
 * prefix, and `/mcp` attributes tools to servers the same way.
 */
import { describe, expect, test } from "bun:test";
import { namespacedToolName, serverPrefix } from "../src/mcp/client";
import { McpManager } from "../src/mcp/manager";
import { CONFIG_DIR_NAME } from "../src/brand";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { trustForSession } from "../src/agent/trust";
import type { McpServerConfig } from "../src/mcp/config";

const here = dirname(fileURLToPath(import.meta.url));
const COLLIDER = join(here, "fixtures", "mock-mcp-colliding-names.mjs");

function project(servers: Record<string, McpServerConfig>): string {
    const root = mkdtempSync(join(tmpdir(), "loop-mcp-naming-"));
    mkdirSync(join(root, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(root, CONFIG_DIR_NAME, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    trustForSession(root);
    return root;
}

const LIMIT = 64;

describe("a tool key always stays inside the provider's limit", () => {
    test("a long server plus a long tool still fits", () => {
        const key = namespacedToolName("a".repeat(80), "b".repeat(80));
        expect(key.length).toBeLessThanOrEqual(LIMIT);
        expect(/^[a-zA-Z0-9_-]+$/.test(key)).toBe(true);
    });

    test("the server prefix survives a server name long enough to eat the budget", () => {
        // It used to not: the shortener fell back to slicing the tail off the
        // whole string, taking `mcp__<server>__` with it — so dropTools() could
        // never withdraw these tools and /mcp could never attribute them.
        const server = "an_extremely_long_mcp_server_name_that_someone_actually_typed";
        const key = namespacedToolName(server, "some_tool");
        expect(key.startsWith(serverPrefix(server))).toBe(true);
        expect(key.length).toBeLessThanOrEqual(LIMIT);
    });

    test("prefixes stay distinguishable for ordinary names", () => {
        expect(serverPrefix("my-fs")).toBe("mcp__my_fs__");
        expect(serverPrefix("github")).not.toBe(serverPrefix("gitlab"));
    });
});

describe("two tools never collapse into one key", () => {
    test("names that differ only where the shortener cuts both survive", async () => {
        const root = project({ jira: { command: process.execPath, args: [COLLIDER] } });
        const manager = new McpManager();
        try {
            await manager.init(root);
            const server = manager.getServer("jira");
            expect(server?.status).toBe("ready");

            const keys = Object.keys(manager.getTools());
            // The fixture exposes four tools: two that shorten to the same
            // string, and two that sanitize to the same string.
            expect(keys.length).toBe(4);
            expect(new Set(keys).size).toBe(4);
            expect(server?.toolCount).toBe(4);
            for (const key of keys) {
                expect(key.length).toBeLessThanOrEqual(LIMIT);
                expect(key.startsWith(serverPrefix("jira"))).toBe(true);
            }
        } finally {
            await manager.close();
        }
    });

    test("every tool is still withdrawn when the server goes", async () => {
        const root = project({ jira: { command: process.execPath, args: [COLLIDER] } });
        const manager = new McpManager();
        await manager.init(root);
        expect(Object.keys(manager.getTools()).length).toBe(4);
        await manager.close();
        // Withdrawal is by prefix; a key that lost its prefix used to linger
        // here, leaving a dead server's tool in every later turn.
        expect(manager.getTools()).toEqual({});
    });
});
