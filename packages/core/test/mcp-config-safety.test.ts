/**
 * The configuration edges: what gets printed, what a folder change means, and
 * where `${env:VAR}` is honoured. Each of these was a way for a correct config
 * to behave wrongly without saying anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_DIR_NAME } from "../src/brand";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpManager } from "../src/mcp/manager";
import { redactServerConfig, withheldProjectServers, type McpServerConfig } from "../src/mcp/config";
import { buildTransport } from "../src/mcp/transport";
import { getSetting, setSetting } from "../src/settings";
import { trustForSession } from "../src/agent/trust";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "fixtures", "mock-mcp-server.mjs");

const stdio = (pidfile?: string): McpServerConfig => ({
    command: process.execPath,
    args: [MOCK],
    ...(pidfile ? { env: { MOCK_MCP_PIDFILE: pidfile } } : {}),
});

function project(servers: Record<string, McpServerConfig>, trusted = true): string {
    const root = mkdtempSync(join(tmpdir(), "loop-mcp-cfg-"));
    mkdirSync(join(root, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(root, CONFIG_DIR_NAME, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    if (trusted) trustForSession(root);
    return root;
}

function tempPidfile(): string {
    return join(mkdtempSync(join(tmpdir(), "loop-mcp-cfg-pid-")), "pid");
}

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

describe("printing a server config", () => {
    test("a literal credential never reaches the terminal", () => {
        const printed = redactServerConfig({
            type: "http",
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer sk-live-abcdef", "X-Api-Version": "2" },
            clientSecret: "shh-this-is-real",
        });
        expect(JSON.stringify(printed)).not.toContain("sk-live-abcdef");
        expect(JSON.stringify(printed)).not.toContain("shh-this-is-real");
        // Non-secret headers stay legible — redacting everything hides the
        // configuration the user came to read.
        expect(JSON.stringify(printed)).toContain("X-Api-Version");
        expect(JSON.stringify(printed)).toContain('"2"');
    });

    test("an ${env:VAR} reference stays visible — it names a secret, it isn't one", () => {
        const printed = redactServerConfig({
            type: "http",
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "${env:EXAMPLE_TOKEN}" },
            clientSecret: "${env:EXAMPLE_SECRET}",
        });
        expect(JSON.stringify(printed)).toContain("${env:EXAMPLE_TOKEN}");
        expect(JSON.stringify(printed)).toContain("${env:EXAMPLE_SECRET}");
    });

    test("a stdio server's secret-shaped env is redacted too", () => {
        const printed = redactServerConfig({
            command: "npx",
            env: { GITHUB_TOKEN: "ghp_realtokenvalue", LOG_LEVEL: "debug" },
        });
        expect(JSON.stringify(printed)).not.toContain("ghp_realtokenvalue");
        expect(JSON.stringify(printed)).toContain("debug");
    });

    test("redacting does not mutate the config it was given", () => {
        const cfg: McpServerConfig = { command: "npx", env: { API_KEY: "real" } };
        redactServerConfig(cfg);
        expect((cfg as { env: Record<string, string> }).env.API_KEY).toBe("real");
    });
});

describe("${env:VAR} in a remote server's URL", () => {
    test("is resolved before the request goes out", () => {
        process.env.LOOP_TEST_MCP_HOST = "tenant-42.example.com";
        const transport = buildTransport({ type: "http", url: "https://${env:LOOP_TEST_MCP_HOST}/mcp" }) as {
            url: string;
        };
        expect(transport.url).toBe("https://tenant-42.example.com/mcp");
        delete process.env.LOOP_TEST_MCP_HOST;
    });
});

describe("servers withheld for lack of trust", () => {
    test("a disabled server is not blamed on trust", () => {
        const root = project({ live: stdio(), off: { ...(stdio() as object), enabled: false } as McpServerConfig });
        expect(withheldProjectServers(root, false)).toEqual(["live"]);
        expect(withheldProjectServers(root, true)).toEqual([]);
    });
});

describe("changing directory", () => {
    test("swaps project servers and leaves user-scope ones connected", async () => {
        const pidfile = tempPidfile();
        setSetting("mcpServers", { userwide: stdio(pidfile) });
        const from = project({ alpha: stdio() });
        const to = project({ beta: stdio() });

        manager = new McpManager();
        await manager.init(from);
        expect(manager.getServer("alpha")?.status).toBe("ready");
        const pidBefore = readFileSync(pidfile, "utf8");

        await manager.setCwd(to);

        // The folder we left takes its servers with it; the new folder's arrive.
        expect(manager.getServer("alpha")).toBeUndefined();
        expect(manager.getServer("beta")?.status).toBe("ready");
        // A user-scope server belongs to no directory. Same process, so it was
        // never torn down and rebuilt behind the user's back.
        expect(manager.getServer("userwide")?.status).toBe("ready");
        expect(readFileSync(pidfile, "utf8")).toBe(pidBefore);
    });

    test("moving into an untrusted folder leaves its project servers alone", async () => {
        const from = project({ alpha: stdio() });
        const to = project({ beta: stdio() }, false);
        manager = new McpManager();
        await manager.init(from);
        await manager.setCwd(to);
        expect(manager.getServer("alpha")).toBeUndefined();
        expect(manager.getServer("beta")).toBeUndefined();
        expect(manager.getTools()).toEqual({});
    });
});
