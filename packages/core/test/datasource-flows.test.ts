import { describe, expect, test } from "bun:test";
import { parseDatasourceConfig } from "../src/rpc/datasource-flows";

const valid = {
    type: "postgres",
    host: "db.example.com",
    port: 5432,
    database: "app",
    user: "reader",
};

describe("parseDatasourceConfig", () => {
    test("accepts a complete config", () => {
        expect(parseDatasourceConfig(valid)).toEqual({
            type: "postgres",
            host: "db.example.com",
            port: 5432,
            database: "app",
            user: "reader",
        });
    });

    test("fills the engine's default port when none is given", () => {
        expect(parseDatasourceConfig({ ...valid, port: undefined }).port).toBe(5432);
        expect(parseDatasourceConfig({ ...valid, type: "mysql", port: undefined }).port).toBe(3306);
        expect(parseDatasourceConfig({ ...valid, type: "redshift", port: "" }).port).toBe(5439);
    });

    test("rejects a port that is not really a port", () => {
        // parseInt would take "5432abc" as 5432 and save a port nobody typed.
        for (const port of ["5432abc", 0, 70_000, -1, 1.5, "nope"]) {
            expect(() => parseDatasourceConfig({ ...valid, port })).toThrow(/not a valid port/);
        }
    });

    test("rejects an unknown engine rather than storing a broken row", () => {
        expect(() => parseDatasourceConfig({ ...valid, type: "oracle" })).toThrow(/unknown datasource type/);
    });

    test("requires the fields a connection cannot be made without", () => {
        expect(() => parseDatasourceConfig({ ...valid, host: "  " })).toThrow(/needs a host/);
        expect(() => parseDatasourceConfig({ ...valid, database: "" })).toThrow(/needs a database/);
        expect(() => parseDatasourceConfig({ ...valid, user: undefined })).toThrow(/needs a user/);
        expect(() => parseDatasourceConfig(null)).toThrow(/config required/);
    });

    test("distinguishes an absent password from a cleared one", () => {
        // Absent means "keep the stored secret" — the list response withholds
        // it, so an edit form has none to send back. Empty means "remove it".
        expect(parseDatasourceConfig(valid).password).toBeUndefined();
        expect(parseDatasourceConfig({ ...valid, password: "" }).password).toBe("");
        expect(parseDatasourceConfig({ ...valid, password: "hunter2" }).password).toBe("hunter2");
    });

    test("keeps an env placeholder verbatim for resolution at connect time", () => {
        const config = parseDatasourceConfig({ ...valid, password: "${env:PGPASSWORD}" });
        expect(config.password).toBe("${env:PGPASSWORD}");
    });

    test("only sets ssl when it was actually asked for", () => {
        expect(parseDatasourceConfig(valid).ssl).toBeUndefined();
        expect(parseDatasourceConfig({ ...valid, ssl: "yes" }).ssl).toBeUndefined();
        expect(parseDatasourceConfig({ ...valid, ssl: true }).ssl).toBe(true);
    });
});
