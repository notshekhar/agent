import { describe, expect, test } from "bun:test";

import { plainError } from "../src/rpc/server";

/**
 * Errors have to survive leaving the process.
 *
 * `JSON.stringify(new Error("boom"))` is `{}` — message, name and stack are
 * all non-enumerable — so every failure the event stream carried reached a
 * client as an empty object. MEASURED against the desktop app: a `write` that
 * threw rendered a red row whose whole detail was two braces, and a 401 ended
 * the turn with a banner that said nothing.
 */
describe("flattening an error for the wire", () => {
    test("keeps the message JSON would have dropped", () => {
        const flat = plainError(new Error("EACCES: permission denied")) as Record<string, unknown>;
        expect(flat.message).toBe("EACCES: permission denied");
        expect(flat.name).toBe("Error");
    });

    test("survives the round trip JSON.stringify could not", () => {
        const wire = JSON.parse(JSON.stringify(plainError(new Error("boom"))));
        expect(wire.message).toBe("boom");
        // The whole point: the same value without the rewrite is `{}`.
        expect(JSON.stringify(new Error("boom"))).toBe("{}");
    });

    test("keeps the enumerable fields a client's formatter reads", () => {
        // How the AI SDK reports a provider failure — the readable line is in
        // responseBody, and statusCode is what turns it into "(HTTP 401)".
        const error = Object.assign(new Error("the whole request dump"), {
            name: "AI_APICallError",
            statusCode: 401,
            responseBody: '{"error":{"message":"invalid x-api-key"}}',
        });
        const flat = plainError(error) as Record<string, unknown>;
        expect(flat.statusCode).toBe(401);
        expect(flat.responseBody).toBe('{"error":{"message":"invalid x-api-key"}}');
    });

    test("drops the stack, which is noise in a UI and the biggest field", () => {
        const flat = plainError(new Error("boom")) as Record<string, unknown>;
        expect(flat.stack).toBeUndefined();
    });

    test("follows the cause chain, where the real syscall failure hides", () => {
        const error = new Error("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
        const flat = plainError(error) as { cause?: Record<string, unknown> };
        expect(flat.cause?.code).toBe("ECONNREFUSED");
    });

    test("reaches an Error nested inside a tool-error payload", () => {
        // The shape `tool-error` broadcasts: the Error is a FIELD, not the
        // payload, so a top-level-only rewrite would still send `{}`.
        const flat = plainError({ toolCallId: "c1", toolName: "write", error: new Error("nope") }) as {
            error?: Record<string, unknown>;
        };
        expect(flat.error?.message).toBe("nope");
    });

    test("leaves a plain value alone", () => {
        expect(plainError("just a string")).toBe("just a string");
        expect(plainError({ reason: "auto" })).toEqual({ reason: "auto" });
    });

    test("stops rather than recursing forever on a cycle", () => {
        const a: Record<string, unknown> = {};
        a.self = a;
        expect(() => JSON.stringify(plainError(a))).not.toThrow();
    });
});
