#!/usr/bin/env node
/**
 * Completes the MCP handshake and then fails `tools/list`, and keeps running
 * afterwards — the shape that used to leave an orphaned child behind, because
 * the client was already live by the time the connect failed.
 */
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

if (process.env.MOCK_MCP_PIDFILE) writeFileSync(process.env.MOCK_MCP_PIDFILE, String(process.pid));

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

rl.on("line", (line) => {
    let req;
    try {
        req = JSON.parse(line);
    } catch {
        return;
    }
    const { id, method, params } = req;
    if (method === "initialize") {
        send({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: params?.protocolVersion ?? "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "mock-mcp-broken-list", version: "0.0.0" },
            },
        });
        return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: "tools/list is broken" } });
        return;
    }
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method: ${method}` } });
});

// Outlive the failed connect, the way a real server would.
setInterval(() => {}, 1 << 30);
