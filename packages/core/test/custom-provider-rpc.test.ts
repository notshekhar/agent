/**
 * The RPC that lets a remote client CREATE a custom gateway.
 *
 * `auth.login` could only ever hand a credential to a provider that already
 * existed, which is why the desktop app could see the gateways `loop login`
 * had made and not make one — the Providers page said so in prose. A custom
 * provider has no prior existence: it is its config, so creating one needs its
 * own surface (packages/core/src/rpc/custom-providers.ts).
 *
 * ── Why nothing here writes ──
 *
 * The auth store cannot be isolated from the developer's real one: under Bun
 * `os.homedir()` ignores a reassigned `$HOME` (measured — see the note at the
 * top of auth-flows.test.ts), and `getConfigDir()` resolves at module load.
 * Every case below therefore exercises parsing, validation, and the refusal
 * paths, all of which reject BEFORE `saveCustomProvider` is reached.
 */
import { describe, expect, test } from "bun:test";

import {
    CUSTOM_PROVIDER_SDKS,
    draftToConfig,
    listCustomProviderSummaries,
    parseCustomProviderAuth,
    parseCustomProviderDraft,
    removeCustomProvider,
    saveCustomProviderConfig,
    setActiveCustomProvider,
} from "../src/rpc/custom-providers";

const draft = (overrides: Record<string, unknown> = {}) => ({
    name: "bifrost",
    sdk: "anthropic",
    baseURL: "http://bifrost.internal/anthropic",
    auth: { kind: "apikey", apiKey: "sk-live" },
    ...overrides,
});

describe("parsing a draft", () => {
    test("lowercases and trims the name", () => {
        expect(parseCustomProviderDraft(draft({ name: "  BiFrost " })).name).toBe("bifrost");
    });

    /**
     * The name becomes part of a model id — `custom:<name>/<model>` — so a
     * slash or a colon in it produces ids that no longer parse, and the failure
     * surfaces much later as an unroutable model rather than here.
     */
    test("refuses a name that would break model ids", () => {
        for (const bad of ["bi frost", "bi/frost", "bi:frost", "bi_frost", ""]) {
            expect(() => parseCustomProviderDraft(draft({ name: bad }))).toThrow();
        }
    });

    test("refuses an API shape loop cannot speak", () => {
        expect(() => parseCustomProviderDraft(draft({ sdk: "cohere" }))).toThrow(/sdk must be one of/);
        for (const sdk of CUSTOM_PROVIDER_SDKS) {
            expect(parseCustomProviderDraft(draft({ sdk })).sdk).toBe(sdk);
        }
    });

    test("requires a base URL", () => {
        expect(() => parseCustomProviderDraft(draft({ baseURL: "  " }))).toThrow(/baseURL required/);
    });

    test("takes bare model ids as well as objects, and drops the empties", () => {
        const parsed = parseCustomProviderDraft(
            draft({ models: ["  opus  ", "", { id: "sonnet", name: "Sonnet", contextWindow: 200_000 }, {}] }),
        );
        expect(parsed.models).toEqual([
            { id: "opus" },
            { id: "sonnet", name: "Sonnet", contextWindow: 200_000 },
        ]);
    });

    test("keeps only headers that name something", () => {
        const parsed = parseCustomProviderDraft(draft({ headers: { "X-Key": "v", "": "orphan", A: 7 } }));
        expect(parsed.headers).toEqual({ "X-Key": "v" });
    });
});

describe("the auth block", () => {
    test("carries each kind through with its own required field", () => {
        expect(parseCustomProviderAuth({ kind: "bearer", token: "t" })).toEqual({
            kind: "bearer",
            token: "t",
        });
        expect(parseCustomProviderAuth({ kind: "env", var: "GW_KEY" })).toEqual({
            kind: "env",
            var: "GW_KEY",
        });
        expect(parseCustomProviderAuth({ kind: "helper", command: "vault read" })).toEqual({
            kind: "helper",
            command: "vault read",
        });
        expect(parseCustomProviderAuth({ kind: "none" })).toEqual({ kind: "none" });
    });

    test("an oauth block with no overrides means discover everything", () => {
        expect(parseCustomProviderAuth({ kind: "oauth" })).toEqual({ kind: "oauth" });
        expect(parseCustomProviderAuth({ kind: "oauth", oauth: { scopes: ["openid"] } })).toEqual({
            kind: "oauth",
            oauth: { scopes: ["openid"] },
        });
    });

    test("rejects a kind with its field missing, rather than storing a blank credential", () => {
        expect(() => parseCustomProviderAuth({ kind: "apikey", apiKey: "" })).toThrow(/apiKey required/);
        expect(() => parseCustomProviderAuth({ kind: "env" })).toThrow(/var required/);
        expect(() => parseCustomProviderAuth({ kind: "shrug" })).toThrow(/unknown auth kind/);
    });

    /**
     * `keep` is the edit form's only honest option: the stored secret is
     * deliberately never sent down to it, so an untouched field cannot mean
     * "clear the credential".
     */
    test("'keep' needs something saved to keep", () => {
        expect(() => parseCustomProviderAuth({ kind: "keep" })).toThrow(/no saved credential/);
        expect(
            parseCustomProviderAuth({ kind: "keep" }, {
                name: "x",
                sdk: "openai",
                baseURL: "http://x",
                apiKey: "sk-stored",
            }),
        ).toEqual({ kind: "apikey", apiKey: "sk-stored" });
    });
});

describe("the config a draft becomes", () => {
    /**
     * Older loop versions read the same auth.json and know only the flat key,
     * so an apikey gateway has to keep it mirrored — and every other kind has
     * to blank it rather than leave a stale secret behind.
     */
    test("mirrors an api key into the legacy flat field and blanks it otherwise", () => {
        expect(draftToConfig(parseCustomProviderDraft(draft())).apiKey).toBe("sk-live");
        expect(
            draftToConfig(parseCustomProviderDraft(draft({ auth: { kind: "env", var: "K" } }))).apiKey,
        ).toBe("");
    });
});

describe("refusals", () => {
    /**
     * A gateway with no models saves cleanly and then produces an empty picker
     * with nothing to explain it: the catalog only invents fallback models for
     * a config whose list is ABSENT. The terminal wizard refuses for the same
     * reason.
     */
    test("saving needs at least one model", () => {
        expect(() => saveCustomProviderConfig(draft())).toThrow(/at least one model/);
        expect(() => saveCustomProviderConfig(draft({ models: [] }))).toThrow(/at least one model/);
    });

    test("removing something that is not there is an error, not a silent success", () => {
        expect(() => removeCustomProvider({ name: "definitely-not-configured" })).toThrow(/no custom provider/);
        expect(() => setActiveCustomProvider({ name: "definitely-not-configured" })).toThrow(
            /no custom provider/,
        );
        expect(() => removeCustomProvider({})).toThrow(/name required/);
    });
});

describe("listing", () => {
    test("never echoes a stored credential back", () => {
        for (const summary of listCustomProviderSummaries().providers) {
            expect(summary.id).toBe(`custom:${summary.name}`);
            expect(JSON.stringify({ ...summary, headers: undefined })).not.toContain("apiKey");
            expect(typeof summary.authDescription).toBe("string");
        }
    });
});
