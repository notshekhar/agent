/**
 * `sql` tool — read-only SQL access for the data-analyst agent. Takes a saved
 * datasource connectionId and a query, runs it through the two-layer read-only
 * guard (see datasources/validate.ts + client.ts), and returns the rows.
 *
 * Part of the main toolset (createTools/TOOL_NAMES): the unrestricted default
 * agent gets it automatically, and restricted agents keep it only if their
 * allowlist names it (plan/data-analyst do, via READONLY_TOOLS). Any failure (a
 * rejected mutation, an unknown connection, a database error) throws, surfacing
 * as a tool-error.
 */
import { tool } from "ai";
import { z } from "zod";
import { PRODUCT_NAME } from "../brand";
import { runReadOnlyQuery } from "../datasources/client";
import { listDatasources } from "../datasources/config";

export interface SqlToolContext {
    abortSignal?: AbortSignal;
}

/** How to get a connection when there is none — the agent can write one itself. */
const NO_CONNECTIONS = `No datasources are configured yet. You can add one yourself: read ${PRODUCT_NAME}://docs/config.md ("Add a datasource") for the file location and JSON shape, write the connection, then ask the user to run /reload. (/datasource is the interactive equivalent, and is where the user tests a connection.)`;

function knownConnections(): string {
    const ids = listDatasources().map((d) => d.id);
    return ids.length ? ids.join(", ") : `(none configured — see ${PRODUCT_NAME}://docs/config.md to add one)`;
}

/** Enumerate configured connections (id · type · host/db) for the tool description. */
function connectionCatalog(): string {
    const sources = listDatasources();
    if (sources.length === 0) return NO_CONNECTIONS;
    const lines = sources.map(({ id, config }) => `  - ${id} (${config.type} · ${config.host}/${config.database})`);
    return `Available connectionId values:\n${lines.join("\n")}`;
}

function formatRows(rows: unknown): string {
    if (Array.isArray(rows)) {
        if (rows.length === 0) return "(0 rows)";
        const body = JSON.stringify(rows, null, 2);
        return `${rows.length} row(s):\n${body}`;
    }
    return JSON.stringify(rows ?? null, null, 2);
}

export function createSqlTool(ctx: SqlToolContext) {
    return tool({
        description:
            "Run a READ-ONLY SQL query against a configured datasource and return the rows. " +
            "Only SELECT / WITH / EXPLAIN / SHOW / DESCRIBE statements are allowed — any " +
            "INSERT/UPDATE/DELETE/ALTER/DDL is rejected. Queries run inside a rolled-back " +
            "read-only transaction. Use information_schema (or the dialect's catalog) to " +
            "discover tables and columns before querying; add a LIMIT to exploratory queries.\n\n" +
            connectionCatalog(),
        inputSchema: z.object({
            connectionId: z.string().describe("Id of a saved datasource (see the list in the description above)"),
            query: z.string().describe("A single read-only SQL statement"),
        }),
        execute: async ({ connectionId, query }, options) => {
            const signal = options?.abortSignal ?? ctx.abortSignal;
            if (signal?.aborted) throw new Error("Operation aborted");
            if (!connectionId?.trim()) {
                throw new Error(`connectionId is required. Known connections: ${knownConnections()}`);
            }
            const rows = await runReadOnlyQuery(connectionId.trim(), query);
            return formatRows(rows);
        },
    });
}
