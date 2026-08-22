import { CONFIG_DIR_NAME } from "../src/brand";
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveSecrets } from "../src/mcp/config";
import { connectServer, namespacedToolName, serverPrefix } from "../src/mcp/client";
import { McpManager } from "../src/mcp/manager";
import { getSetting, setSetting } from "../src/settings";
import type { McpServerConfig } from "../src/mcp/config";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "fixtures", "mock-mcp-server.mjs");
const stdioConfig: McpServerConfig = { command: process.execPath, args: [SERVER] };

describe("namespacing", () => {
    test("namespacedToolName follows mcp__server__tool", () => {
        expect(namespacedToolName("fs", "read_file")).toBe("mcp__fs__read_file");
        expect(serverPrefix("fs")).toBe("mcp__fs__");
    });

    test("sanitizes unsafe characters in names", () => {
        expect(namespacedToolName("my server", "do.thing")).toBe("mcp__my_server__do_thing");
    });
});

describe("resolveSecrets", () => {
    test("substitutes ${env:VAR} from process.env", () => {
        process.env.LOOP_TEST_TOKEN = "secret123";
        expect(resolveSecrets("Bearer ${env:LOOP_TEST_TOKEN}")).toBe("Bearer secret123");
        delete process.env.LOOP_TEST_TOKEN;
    });

    test("unknown vars resolve to empty string", () => {
        expect(resolveSecrets("x=${env:LOOP_DEFINITELY_UNSET}")).toBe("x=");
    });
});

describe("connectServer (stdio, real MCP handshake)", () => {
    test("connects and namespaces the server's tools", async () => {
        const { client, tools, toolCount } = await connectServer("mock", stdioConfig);
        try {
            expect(toolCount).toBe(2);
            expect(Object.keys(tools).sort()).toEqual(["mcp__mock__echo", "mcp__mock__structured"]);
        } finally {
            await client.close();
        }
    });

    // Regression: a server that returns its payload only via structuredContent
    // (empty content array, like codespec) must not be lost — the AI SDK's
    // automatic-schema path drops structuredContent, so we surface it as text.
    test("structuredContent-only result is preserved as text content", async () => {
        const { client, tools } = await connectServer("mock", stdioConfig);
        try {
            const tool = tools["mcp__mock__structured"] as {
                execute: (i: unknown, o: unknown) => Promise<unknown>;
            };
            const result = (await tool.execute({ text: "hi" }, {})) as {
                content: Array<{ type: string; text: string }>;
            };
            const textPart = result.content.find((p) => p.type === "text");
            expect(textPart).toBeDefined();
            expect(textPart!.text).toContain('"echo": "hi"');
            expect(textPart!.text).toContain('"items"');
        } finally {
            await client.close();
        }
    });
});

describe("McpManager", () => {
    let manager: McpManager | undefined;
    // init() merges global settings — null them out so tests see only the
    // project mcp.json they create (and never hit the user's real servers).
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

    test("init connects servers and aggregates tools; close tears down", async () => {
        manager = new McpManager();
        // Drive connect directly via a synthetic settings-free path: write a
        // project mcp.json the loader reads.
        const cwd = makeProjectWith({ mock: stdioConfig });
        await manager.init(cwd);

        const servers = manager.listServers();
        expect(servers).toHaveLength(1);
        expect(servers[0]).toMatchObject({ name: "mock", status: "ready", toolCount: 2 });
        expect(Object.keys(manager.getTools()).sort()).toEqual(["mcp__mock__echo", "mcp__mock__structured"]);

        await manager.close();
        expect(manager.listServers()).toHaveLength(0);
        expect(manager.getTools()).toEqual({});
    });

    test("a failing server is isolated as error, not thrown", async () => {
        manager = new McpManager();
        const cwd = makeProjectWith({
            mock: stdioConfig,
            broken: { command: "this-command-does-not-exist-pi", args: [] },
        });
        await manager.init(cwd);

        const byName = Object.fromEntries(manager.listServers().map((s) => [s.name, s]));
        expect(byName.mock.status).toBe("ready");
        expect(byName.broken.status).toBe("error");
        // The good server's tools still load.
        expect(Object.keys(manager.getTools())).toContain("mcp__mock__echo");
    });
});

describe("OAuth provider", () => {
    test("persists tokens/client info and reports needs-auth via a thrown redirect", async () => {
        const { McpOAuthProvider, hasStoredTokens, clearMcpAuth, McpAuthRequiredError } =
            await import("../src/mcp/oauth");
        const server = `test-oauth-${Date.now()}`;
        clearMcpAuth(server);
        expect(hasStoredTokens(server)).toBe(false);

        const provider = new McpOAuthProvider(server, "http://127.0.0.1:8976/callback");
        provider.saveClientInformation({ client_id: "abc" });
        provider.saveTokens({ access_token: "tok", token_type: "bearer" });
        expect(provider.clientInformation()).toMatchObject({ client_id: "abc" });
        expect(hasStoredTokens(server)).toBe(true);

        // No onRedirect opener → a forced redirect surfaces as needs-auth.
        expect(() => provider.redirectToAuthorization(new URL("https://auth.example/authorize"))).toThrow(
            McpAuthRequiredError,
        );

        clearMcpAuth(server);
        expect(hasStoredTokens(server)).toBe(false);
    });
});

/** Write a throwaway project dir with .loop/mcp.json so loadMcpServers picks it up. */
function makeProjectWith(servers: Record<string, McpServerConfig>): string {
    const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const root = mkdtempSync(join(tmpdir(), "loop-mcp-test-"));
    mkdirSync(join(root, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(root, CONFIG_DIR_NAME, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    return root;
}

/**
 * Signing in to a server this process has not connected.
 *
 * `mcp.list` deliberately does not connect (up to 30s per server), so on a
 * freshly-opened settings page the manager knows nothing — and the login used
 * to refuse on that basis, telling the user to reconnect first. The config on
 * disk is all a login actually needs.
 */
describe("the MCP login flow", () => {
    test("starts for a configured server the manager has never connected", async () => {
        const { startMcpLogin, cancelMcpLogin, resetMcpLogins, listMcpServers } = await import("../src/rpc/mcp-flows");
        const { getMcpManager } = await import("../src/mcp/manager");
        resetMcpLogins();
        const root = makeProjectWith({ unconnected: { type: "http", url: "http://127.0.0.1:9/mcp" } });

        // Nothing has connected it — this is exactly the state the panel is in.
        expect(getMcpManager().getServer("unconnected")).toBeUndefined();
        expect(listMcpServers(root).servers.map((s) => s.name)).toContain("unconnected");

        // The URL is a dead local port: the flow starts (which is what this
        // pins) and its background half fails immediately, with no network.
        const flow = startMcpLogin("unconnected", root);
        expect(flow.server).toBe("unconnected");
        expect(flow.flowId).toBeTruthy();
        cancelMcpLogin(flow.flowId);
        resetMcpLogins();
    });

    test("still refuses a name that is configured nowhere", async () => {
        const { startMcpLogin, resetMcpLogins } = await import("../src/rpc/mcp-flows");
        resetMcpLogins();
        const root = makeProjectWith({});
        expect(() => startMcpLogin("nosuchserver", root)).toThrow(/unknown MCP server/);
    });
});

/**
 * What the /mcp panel and any GUI client read. The tool list used to be
 * matched against the RAW server name with `includes`, so a server whose name
 * carried a dash showed none of its tools, and a server whose name was a
 * suffix of another's showed the other's too.
 */
describe("listMcpServers", () => {
    test("attributes tools by the namespaced prefix, not the raw name", async () => {
        const { listMcpServers } = await import("../src/rpc/mcp-flows");
        const { getMcpManager } = await import("../src/mcp/manager");
        const saved = getSetting("mcpServers");
        setSetting("mcpServers", {});
        const root = makeProjectWith({ "my-fs": stdioConfig, fs: stdioConfig, myfs: stdioConfig });
        try {
            // The manager is a process-global singleton whose `init()` is a
            // no-op once ANYTHING has initialized it, and `config.reload`
            // (rpc/server.ts) initializes it as a matter of course — which
            // rpc.test.ts exercises. Test files share one module registry, and
            // bun discovers them in filesystem order, so this is decided by the
            // platform: on Linux CI rpc.test.ts ran first and the init below
            // connected nothing, leaving every row tool-less; macOS happened to
            // order it the other way, which is why it stayed green locally.
            // Closing first makes the test own the manager either way.
            await getMcpManager().close();
            await getMcpManager().init(root);
            const byName = Object.fromEntries(listMcpServers(root).servers.map((s) => [s.name, s]));
            // A dash in the name is sanitized in the tool key; the row must
            // still find its own tools.
            expect(byName["my-fs"].tools).toEqual(["mcp__my_fs__echo", "mcp__my_fs__structured"]);
            // And "fs" must not claim "myfs"'s tools.
            expect(byName.fs.tools).toEqual(["mcp__fs__echo", "mcp__fs__structured"]);
            expect(byName.myfs.tools).toEqual(["mcp__myfs__echo", "mcp__myfs__structured"]);
        } finally {
            await getMcpManager().close();
            setSetting("mcpServers", saved as Record<string, McpServerConfig> | undefined);
        }
    });
});

describe("parseServerConfig", () => {
    test("refuses headers/env that aren't flat string maps", async () => {
        const { parseServerConfig } = await import("../src/rpc/mcp-flows");
        expect(() => parseServerConfig({ type: "http", url: "https://x.dev/mcp", headers: { a: { b: 1 } } })).toThrow(
            /headers\.a must be a string/,
        );
        expect(() => parseServerConfig({ command: "npx", env: { TOKEN: 5 } })).toThrow(/env\.TOKEN must be a string/);
        expect(() => parseServerConfig({ command: "npx", env: ["TOKEN=1"] })).toThrow(/env must be an object/);
    });

    test("keeps a valid map", () => {
        expect(
            require("../src/rpc/mcp-flows").parseServerConfig({
                command: "npx",
                env: { TOKEN: "${env:GH_TOKEN}" },
            }),
        ).toEqual({ type: "stdio", command: "npx", env: { TOKEN: "${env:GH_TOKEN}" } });
    });
});
