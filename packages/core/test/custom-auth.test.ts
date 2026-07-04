import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    authHeaderForSdk,
    clearHelperCache,
    createCustomAuthFetch,
    customAuthHeaders,
    describeCustomAuth,
    normalizeCustomAuth,
    resolveCustomCredential,
    type CustomAuthConfig,
} from "../src/auth/custom-auth";
import { withLegacyKeyMirror } from "../src/auth";
import type { CustomProviderAuth } from "../src/types";

const cfg = (over: Partial<CustomAuthConfig> = {}): CustomAuthConfig => ({
    name: over.name ?? `t-${Math.random().toString(36).slice(2)}`,
    sdk: "openai-compatible",
    apiKey: "",
    ...over,
});

/** Helper command whose output increments on every real invocation. */
function countingHelper(): { command: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "loop-auth-test-"));
    const file = join(dir, "count");
    return {
        command: `echo x >> "${file}" && wc -l < "${file}"`,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

interface Call {
    url: string;
    headers: Headers;
}

/** Fetch stub: records calls, returns the queued statuses in order (last repeats). */
function stubFetch(statuses: number[]): {
    calls: Call[];
    fetch: (input: unknown, init?: RequestInit) => Promise<Response>;
} {
    const calls: Call[] = [];
    return {
        calls,
        fetch: async (input: unknown, init?: RequestInit) => {
            calls.push({ url: String(input), headers: new Headers(init?.headers) });
            const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
            return new Response("{}", { status });
        },
    };
}

afterEach(() => clearHelperCache());

describe("normalizeCustomAuth", () => {
    test("legacy flat key becomes apikey; empty becomes none; explicit auth wins", () => {
        expect(normalizeCustomAuth({ apiKey: "sk-1" })).toEqual({ kind: "apikey", apiKey: "sk-1" });
        expect(normalizeCustomAuth({ apiKey: "" })).toEqual({ kind: "none" });
        const auth: CustomProviderAuth = { kind: "bearer", token: "t" };
        expect(normalizeCustomAuth({ apiKey: "sk-ignored", auth })).toBe(auth);
    });
});

describe("withLegacyKeyMirror", () => {
    const base = { name: "g", sdk: "openai" as const, baseURL: "https://x", apiKey: "old" };
    test("apikey kind mirrors into the flat field; other kinds blank it", () => {
        expect(withLegacyKeyMirror({ ...base, auth: { kind: "apikey", apiKey: "sk-2" } }).apiKey).toBe("sk-2");
        expect(withLegacyKeyMirror({ ...base, auth: { kind: "bearer", token: "t" } }).apiKey).toBe("");
        expect(withLegacyKeyMirror(base).apiKey).toBe("old"); // no auth → untouched
    });
});

describe("authHeaderForSdk / describeCustomAuth", () => {
    test("vendor header placement", () => {
        expect(authHeaderForSdk("anthropic", "k")).toEqual(["x-api-key", "k"]);
        expect(authHeaderForSdk("google", "k")).toEqual(["x-goog-api-key", "k"]);
        expect(authHeaderForSdk("openai", "k")).toEqual(["authorization", "Bearer k"]);
        expect(authHeaderForSdk("openai-compatible", "k")).toEqual(["authorization", "Bearer k"]);
    });
    test("labels", () => {
        expect(describeCustomAuth({ kind: "env", var: "K" })).toBe("env $K");
        expect(describeCustomAuth({ kind: "none" })).toBe("no credential");
    });
});

describe("resolveCustomCredential", () => {
    test("static kinds", async () => {
        expect(await resolveCustomCredential(cfg({ auth: { kind: "apikey", apiKey: "a" } }))).toBe("a");
        expect(await resolveCustomCredential(cfg({ auth: { kind: "bearer", token: "b" } }))).toBe("b");
        expect(await resolveCustomCredential(cfg({ auth: { kind: "none" } }))).toBeNull();
    });

    test("env reads at call time and throws with the var name when missing", async () => {
        process.env.LOOP_TEST_AUTH_VAR = "from-env";
        try {
            expect(await resolveCustomCredential(cfg({ auth: { kind: "env", var: "LOOP_TEST_AUTH_VAR" } }))).toBe(
                "from-env",
            );
        } finally {
            delete process.env.LOOP_TEST_AUTH_VAR;
        }
        await expect(
            resolveCustomCredential(cfg({ auth: { kind: "env", var: "LOOP_TEST_AUTH_VAR" } })),
        ).rejects.toThrow("LOOP_TEST_AUTH_VAR");
    });

    test("helper output is cached within ttl, re-run on force and after expiry", async () => {
        const h = countingHelper();
        try {
            const c = cfg({ auth: { kind: "helper", command: h.command, ttlMs: 60_000 } });
            expect(await resolveCustomCredential(c)).toBe("1");
            expect(await resolveCustomCredential(c)).toBe("1"); // cache hit
            expect(await resolveCustomCredential(c, { force: true })).toBe("2");

            const expiring = cfg({ auth: { kind: "helper", command: h.command, ttlMs: 1 } });
            expect(await resolveCustomCredential(expiring)).toBe("3");
            await new Promise((r) => setTimeout(r, 10));
            expect(await resolveCustomCredential(expiring)).toBe("4"); // ttl elapsed
        } finally {
            h.cleanup();
        }
    });

    test("helper failure and empty output throw", async () => {
        await expect(resolveCustomCredential(cfg({ auth: { kind: "helper", command: "exit 3" } }))).rejects.toThrow(
            "auth helper failed",
        );
        await expect(resolveCustomCredential(cfg({ auth: { kind: "helper", command: "echo" } }))).rejects.toThrow(
            "printed nothing",
        );
    });
});

describe("createCustomAuthFetch", () => {
    test("undefined for plain apikey/none with no extra headers (SDK default fetch)", () => {
        expect(createCustomAuthFetch(cfg({ auth: { kind: "apikey", apiKey: "k" } }))).toBeUndefined();
        expect(createCustomAuthFetch(cfg({ auth: { kind: "none" } }))).toBeUndefined();
    });

    test("applies extra headers without injecting for apikey kind", async () => {
        const stub = stubFetch([200]);
        const f = createCustomAuthFetch(
            cfg({ auth: { kind: "apikey", apiKey: "k" }, headers: { "X-Team": "ml" } }),
            stub.fetch,
        )!;
        await f("https://gw.test/v1/chat/completions", { headers: { "x-api-key": "sdk-set" } });
        expect(stub.calls[0].headers.get("x-team")).toBe("ml");
        expect(stub.calls[0].headers.get("x-api-key")).toBe("sdk-set"); // untouched
        expect(stub.calls[0].headers.get("authorization")).toBeNull();
    });

    test("bearer injects Authorization regardless of sdk", async () => {
        const stub = stubFetch([200]);
        const f = createCustomAuthFetch(cfg({ sdk: "anthropic", auth: { kind: "bearer", token: "tok" } }), stub.fetch)!;
        await f("https://gw.test/v1/messages");
        expect(stub.calls[0].headers.get("authorization")).toBe("Bearer tok");
    });

    test("env injects into the vendor header", async () => {
        process.env.LOOP_TEST_AUTH_FETCH = "env-key";
        try {
            const stub = stubFetch([200]);
            const f = createCustomAuthFetch(
                cfg({ sdk: "anthropic", auth: { kind: "env", var: "LOOP_TEST_AUTH_FETCH" } }),
                stub.fetch,
            )!;
            await f("https://gw.test/v1/messages");
            expect(stub.calls[0].headers.get("x-api-key")).toBe("env-key");
        } finally {
            delete process.env.LOOP_TEST_AUTH_FETCH;
        }
    });

    test("user-configured header outranks the injected credential", async () => {
        const stub = stubFetch([200]);
        const f = createCustomAuthFetch(
            cfg({ auth: { kind: "bearer", token: "tok" }, headers: { Authorization: "Custom scheme" } }),
            stub.fetch,
        )!;
        await f("https://gw.test/v1/chat/completions");
        expect(stub.calls[0].headers.get("authorization")).toBe("Custom scheme");
    });

    test("helper 401 → force re-resolve → retry once with the fresh key", async () => {
        const h = countingHelper();
        try {
            const stub = stubFetch([401, 200]);
            const f = createCustomAuthFetch(cfg({ auth: { kind: "helper", command: h.command } }), stub.fetch)!;
            const res = await f("https://gw.test/v1/chat/completions");
            expect(res.status).toBe(200);
            expect(stub.calls).toHaveLength(2);
            expect(stub.calls[0].headers.get("authorization")).toBe("Bearer 1");
            expect(stub.calls[1].headers.get("authorization")).toBe("Bearer 2");
        } finally {
            h.cleanup();
        }
    });

    test("static credential does not retry on 401", async () => {
        const stub = stubFetch([401]);
        const f = createCustomAuthFetch(cfg({ auth: { kind: "bearer", token: "tok" } }), stub.fetch)!;
        const res = await f("https://gw.test/v1/chat/completions");
        expect(res.status).toBe(401);
        expect(stub.calls).toHaveLength(1);
    });
});

describe("customAuthHeaders (model discovery)", () => {
    test("places the credential per sdk and degrades to {} on resolution failure", async () => {
        expect(await customAuthHeaders(cfg({ sdk: "anthropic", auth: { kind: "apikey", apiKey: "k" } }))).toEqual({
            "x-api-key": "k",
        });
        expect(await customAuthHeaders(cfg({ auth: { kind: "bearer", token: "t" } }))).toEqual({
            authorization: "Bearer t",
        });
        expect(await customAuthHeaders(cfg({ auth: { kind: "env", var: "LOOP_TEST_UNSET_VAR" } }))).toEqual({});
        expect(await customAuthHeaders(cfg({ auth: { kind: "none" } }))).toEqual({});
    });
});
