#!/usr/bin/env node
/**
 * A server whose tool names collide once loop maps them into a provider's
 * 64-character, `[a-zA-Z0-9_-]` tool-name space. Two names differ only in the
 * middle, which is exactly where the shortener cuts; two differ only by `-`
 * versus `_`, which sanitizing folds together. Verbose real servers (Jira,
 * GitHub) ship names of both shapes.
 */
import { createInterface } from "node:readline";

const TOOLS = [
    "search_issues_using_jql_query_and_return_summary_fields",
    "search_issues_using_jql_query_but_return_summary_fields",
    "get-issue",
    "get_issue",
].map((name) => ({
    name,
    description: `Tool ${name}.`,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
}));

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

rl.on("line", (line) => {
    if (!line.trim()) return;
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
                serverInfo: { name: "mock-colliding", version: "0.0.0" },
            },
        });
        return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
    }
    if (method === "tools/call") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `called ${params?.name}` }] } });
        return;
    }
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } });
});
