/**
 * Wire-side validation for the datasource methods.
 *
 * Mirrors `mcp-flows.parseServerConfig` and exists for the same reason: a
 * client can send anything, and what it sends is written to
 * ~/.loop/datasources.json before anything tries to connect. A silently
 * accepted `{}` becomes a permanent broken row that the GUI then has to
 * explain, and a bad port becomes a connection that fails much later with a
 * message pointing nowhere near the cause.
 */
import type { DataSourceConfig, DataSourceType } from "../datasources/config";

const TYPES: readonly DataSourceType[] = ["postgres", "mysql", "redshift"];

/** Default port per engine, so a form that omits it still connects. */
const DEFAULT_PORT: Record<DataSourceType, number> = {
    postgres: 5432,
    mysql: 3306,
    redshift: 5439,
};

export function parseDatasourceConfig(input: unknown): DataSourceConfig {
    if (typeof input !== "object" || input === null) throw new Error("datasource config required");
    const raw = input as Record<string, unknown>;

    const type = String(raw.type ?? "").trim() as DataSourceType;
    if (!TYPES.includes(type)) {
        throw new Error(`unknown datasource type: ${raw.type} (expected ${TYPES.join(", ")})`);
    }

    const host = String(raw.host ?? "").trim();
    if (!host) throw new Error("a datasource needs a host");

    const database = String(raw.database ?? "").trim();
    if (!database) throw new Error("a datasource needs a database");

    const user = String(raw.user ?? "").trim();
    if (!user) throw new Error("a datasource needs a user");

    // Rejected rather than coerced: `Number("5432abc")` is NaN and `parseInt`
    // would quietly accept it as 5432, saving a port the user never typed.
    const port = raw.port === undefined || raw.port === "" ? DEFAULT_PORT[type] : Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`not a valid port: ${raw.port}`);
    }

    /**
     * `undefined` and `""` mean different things here.
     *
     * Absent means "keep whatever is stored" — the list response withholds
     * secrets, so an edit form has none to send back. Empty string is an
     * explicit clear, which is how a password gets removed at all.
     */
    const password =
        raw.password === undefined ? undefined : String(raw.password);

    return {
        type,
        host,
        port,
        database,
        user,
        ...(password === undefined ? {} : { password }),
        ...(raw.ssl === true ? { ssl: true } : {}),
    };
}
