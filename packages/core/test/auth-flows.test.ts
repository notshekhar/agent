/**
 * The provider-login surface a remote client (the desktop app) drives.
 *
 * Two things are worth pinning down, and neither is obvious from the happy
 * path:
 *
 *   - `auth.providers` must list providers the user has NOT connected. It is a
 *     different question from `auth.status`, and getting it wrong is what left
 *     the app's settings page with nothing to sign in to.
 *   - A flow is an append-only log drained by cursor, so polling twice must not
 *     replay events, and a flow that ends must say so in its log.
 *
 * ── Why this file never writes to the auth store ──
 *
 * It cannot be isolated from the developer's real one. `getConfigDir()` calls
 * `os.homedir()` at module load, and under Bun `os.homedir()` **ignores a
 * reassigned `$HOME`** (measured: setting `process.env.HOME` then reading
 * `homedir()` still returns the real home). The `HOME`-swap idiom elsewhere in
 * this suite therefore only isolates the session DB, which has an explicit
 * `setDbPathForTests` override — the auth store has no such seam.
 *
 * So every assertion here is read-only, and the one flow that is exercised end
 * to end is pointed at a closed port so it fails deterministically: the detect
 * flows only touch the store on SUCCESS, and a success here would overwrite
 * the developer's active provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import * as flows from "../src/rpc/auth-flows";
import { BUILTIN_PROVIDER_IDS } from "../src/types";

/** A port nothing listens on, so the Ollama probe fails without writing. */
const DEAD_ENDPOINT = "http://127.0.0.1:1";
const prevOllamaBase = process.env.LOOP_OLLAMA_BASE_URL;

beforeAll(() => {
    process.env.LOOP_OLLAMA_BASE_URL = DEAD_ENDPOINT;
});

beforeEach(() => {
    flows.resetAuthFlows();
});

afterAll(() => {
    flows.resetAuthFlows();
    if (prevOllamaBase === undefined) delete process.env.LOOP_OLLAMA_BASE_URL;
    else process.env.LOOP_OLLAMA_BASE_URL = prevOllamaBase;
});

describe("authMethodsFor", () => {
    test("offers OAuth only where getModel actually reads it", () => {
        // anthropic HAS a registered OAuth implementation, but its getModel
        // branch reads getApiKey — so offering OAuth would produce a login
        // that appears to succeed and then fails on the first turn.
        expect(flows.authMethodsFor("anthropic")).toEqual(["apikey"]);
        expect(flows.authMethodsFor("openai")).toEqual(["oauth", "apikey"]);
        expect(flows.authMethodsFor("xai")).toEqual(["oauth", "apikey"]);
    });

    test("gives Copilot no API-key path, because it has no API keys", () => {
        expect(flows.authMethodsFor("github-copilot")).toEqual(["oauth"]);
    });

    test("reduces the zero-credential providers to a probe", () => {
        expect(flows.authMethodsFor("bedrock")).toEqual(["detect"]);
        expect(flows.authMethodsFor("ollama")).toEqual(["detect"]);
    });

    test("an unknown provider gets the API-key default", () => {
        // Extension-registered providers arrive here; a key is the right guess
        // and lets one be connected without a core change.
        expect(flows.authMethodsFor("some-extension-provider")).toEqual(["apikey"]);
    });
});

describe("apiKeyEnvVar", () => {
    test("hyphenated ids become underscores, matching getApiKey's fallback", () => {
        expect(flows.apiKeyEnvVar("deepseek")).toBe("DEEPSEEK_API_KEY");
        expect(flows.apiKeyEnvVar("openai-chatgpt")).toBe("OPENAI_CHATGPT_API_KEY");
    });

    test("vercel reads the gateway variable, not a platform token", () => {
        expect(flows.apiKeyEnvVar("vercel")).toBe("AI_GATEWAY_API_KEY");
    });

    test("providers with no key have no variable", () => {
        expect(flows.apiKeyEnvVar("bedrock")).toBeUndefined();
        expect(flows.apiKeyEnvVar("ollama")).toBeUndefined();
        expect(flows.apiKeyEnvVar("github-copilot")).toBeUndefined();
    });
});

describe("listProviderDescriptors", () => {
    test("lists every builtin, connected or not", () => {
        // The point of this RPC: a settings page needs what you COULD connect.
        // Listing only authorized providers is what left the page with nothing
        // to click.
        const ids = new Set(flows.listProviderDescriptors().map((d) => d.id));
        for (const builtin of BUILTIN_PROVIDER_IDS) {
            expect(ids.has(builtin)).toBe(true);
        }
    });

    test("folds a ChatGPT sign-in onto the openai row rather than listing both", () => {
        // Credentials live under `openai-chatgpt` for routing, but the picker
        // has one OpenAI entry — a second row would be one the user cannot act
        // on, and it would claim openai was still disconnected.
        const ids = flows.listProviderDescriptors().map((d) => d.id);
        expect(ids).not.toContain("openai-chatgpt");
    });

    test("every descriptor carries the methods and env var its id implies", () => {
        for (const descriptor of flows.listProviderDescriptors()) {
            if (descriptor.kind !== "builtin") continue;
            expect(descriptor.methods).toEqual(flows.authMethodsFor(descriptor.id));
            expect(descriptor.envVar).toBe(flows.apiKeyEnvVar(descriptor.id));
        }
    });

    test("a provider with a stored credential reports a mode, not 'missing'", () => {
        for (const descriptor of flows.listProviderDescriptors()) {
            if (descriptor.mode === "missing") continue;
            expect(descriptor.authorized).toBe(true);
        }
    });

    test("custom gateways are marked as such and carry their endpoint", () => {
        for (const descriptor of flows.listProviderDescriptors()) {
            if (descriptor.kind !== "custom") continue;
            expect(descriptor.id.startsWith("custom:")).toBe(true);
            expect(descriptor.authorized).toBe(true);
            expect(typeof descriptor.baseURL).toBe("string");
        }
    });
});

describe("auth flows", () => {
    test("rejects a login that has no interactive step", () => {
        // An API key is a single store write; routing it through a flow would
        // mean a secret sitting in a server-side event log.
        expect(() => flows.startAuthFlow({ provider: "anthropic", method: "apikey" })).toThrow(
            /auth\.login/,
        );
    });

    test("rejects a method the provider does not support", () => {
        expect(() => flows.startAuthFlow({ provider: "groq", method: "oauth" })).toThrow(
            /does not support/,
        );
    });

    test("defaults to the interactive method, falling back to the key path", () => {
        // With no `method`, a provider that has OAuth gets OAuth; a key-only
        // provider resolves to `apikey` and is then redirected to auth.login
        // rather than being silently accepted into a flow.
        expect(() => flows.startAuthFlow({ provider: "groq" })).toThrow(/auth\.login/);
    });

    test("requires a provider", () => {
        expect(() => flows.startAuthFlow({ provider: "  " })).toThrow(/provider required/);
    });

    test("an unknown flow id is an error, not a silent no-op", () => {
        expect(() => flows.pollAuthFlow("nope")).toThrow(/unknown login flow/);
        expect(() => flows.answerAuthFlow("nope", "p1", "x")).toThrow(/unknown login flow/);
    });

    test("refuses an answer to a prompt the flow is not waiting on", () => {
        const { flowId } = flows.startAuthFlow({ provider: "ollama", method: "detect" });
        expect(() => flows.answerAuthFlow(flowId, "p1", "x")).toThrow(/not waiting/);
    });

    test("reuses the running flow when the same provider is started twice", () => {
        // A second flow would race the first over the same callback port and
        // the same auth-store entry.
        const first = flows.startAuthFlow({ provider: "ollama", method: "detect" });
        const second = flows.startAuthFlow({ provider: "ollama", method: "detect" });
        expect(second.flowId).toBe(first.flowId);
    });

    test("cancelling ends the flow and records why", () => {
        const { flowId } = flows.startAuthFlow({ provider: "ollama", method: "detect" });
        flows.cancelAuthFlow(flowId);
        const poll = flows.pollAuthFlow(flowId);
        expect(poll.status).toBe("cancelled");
        expect(poll.events.at(-1)).toMatchObject({ type: "error" });
    });

    test("cancelling an already-finished flow is harmless", () => {
        const { flowId } = flows.startAuthFlow({ provider: "ollama", method: "detect" });
        flows.cancelAuthFlow(flowId);
        expect(() => flows.cancelAuthFlow(flowId)).not.toThrow();
        expect(flows.pollAuthFlow(flowId).status).toBe("cancelled");
    });

    test("drains by cursor, so a second poll does not replay events", () => {
        const { flowId } = flows.startAuthFlow({ provider: "ollama", method: "detect" });
        const first = flows.pollAuthFlow(flowId, 0);
        expect(first.events.length).toBeGreaterThan(0);
        const second = flows.pollAuthFlow(flowId, first.cursor);
        expect(second.events).toEqual([]);
        expect(second.cursor).toBe(first.cursor);
    });

    test("a cursor past the end is clamped rather than throwing", () => {
        const { flowId } = flows.startAuthFlow({ provider: "ollama", method: "detect" });
        expect(flows.pollAuthFlow(flowId, 9_999).events).toEqual([]);
    });

    test("an unreachable probe settles as an error carrying the reason", async () => {
        // Pointed at a dead port by beforeAll, so this is deterministic — and
        // it never reaches the store, which only happens on success.
        const { flowId } = flows.startAuthFlow({ provider: "ollama", method: "detect" });
        for (let i = 0; i < 200 && flows.pollAuthFlow(flowId).status === "running"; i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const poll = flows.pollAuthFlow(flowId);
        expect(poll.status).toBe("error");
        // A settled flow with no terminal event would leave the UI spinning.
        expect(poll.events.at(-1)).toMatchObject({ type: "error" });
        expect(poll.events.at(-1)).toHaveProperty("message", expect.stringContaining("not reachable"));
    });
});
