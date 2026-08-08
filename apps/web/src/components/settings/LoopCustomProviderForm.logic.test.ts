import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_FORM,
  buildDraft,
  formStateFrom,
  parseHeaders,
  parseModelIds,
  resolveAuth,
  resolveModels,
  validateForm,
  type CustomProviderFormState,
} from "./LoopCustomProviderForm.logic";
import type { CustomProviderSummary } from "../../loop/providers/custom";

const form = (overrides: Partial<CustomProviderFormState> = {}): CustomProviderFormState => ({
  ...EMPTY_FORM,
  name: "bifrost",
  baseURL: "http://bifrost.internal/anthropic",
  secret: "sk-live",
  modelIds: "claude-opus-5",
  ...overrides,
});

const NO_NAMES: ReadonlySet<string> = new Set();

describe("headers", () => {
  it("splits on the first colon, so a URL value survives", () => {
    expect(parseHeaders("X-Proxy: https://gw.internal:8443/v1")).toEqual({
      "X-Proxy": "https://gw.internal:8443/v1",
    });
  });

  it("accepts the terminal's semicolons as well as one per line", () => {
    expect(parseHeaders("A: 1; B: 2")).toEqual({ A: "1", B: "2" });
    expect(parseHeaders("A: 1\nB: 2")).toEqual({ A: "1", B: "2" });
  });

  it("ignores lines that name no header", () => {
    expect(parseHeaders("nonsense\n: orphan\n\nA: 1")).toEqual({ A: "1" });
  });
});

describe("model ids", () => {
  it("takes commas or newlines and drops duplicates, keeping order", () => {
    expect(parseModelIds("a, b\nc\n a ")).toEqual(["a", "b", "c"]);
  });

  it("keeps the metadata discovery reported for an id the user kept", () => {
    const state = form({
      modelIds: "claude-opus-5\nhand-typed",
      discovered: [{ id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000 }],
    });
    expect(resolveModels(state)).toEqual([
      { id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000 },
      { id: "hand-typed" },
    ]);
  });
});

/**
 * The edit form is never shown the stored key. An untouched field therefore
 * has to mean "leave it alone" — the alternative is a save that silently wipes
 * the credential and leaves a gateway that 401s on the next turn.
 */
describe("a secret left blank on an edit", () => {
  it("keeps the stored credential rather than clearing it", () => {
    expect(resolveAuth(form({ secret: "" }), true)).toEqual({ kind: "keep" });
  });

  it("is still a missing key when there is nothing stored to keep", () => {
    expect(resolveAuth(form({ secret: "" }), false)).toEqual({ kind: "apikey", apiKey: "" });
    expect(
      validateForm(form({ secret: "" }), {
        hasStoredSecret: false,
        existingNames: NO_NAMES,
        stage: "save",
      }),
    ).toBe("API key is required.");
  });

  it("replaces it when the user types a new one", () => {
    expect(resolveAuth(form({ secret: "sk-new" }), true)).toEqual({
      kind: "apikey",
      apiKey: "sk-new",
    });
  });
});

describe("validation", () => {
  it("enforces the name rule the terminal enforces", () => {
    expect(
      validateForm(form({ name: "Bi Frost" }), {
        hasStoredSecret: false,
        existingNames: NO_NAMES,
        stage: "save",
      }),
    ).toBe("Name must be lowercase letters, digits, and hyphens.");
  });

  it("refuses to overwrite an existing gateway by name", () => {
    expect(
      validateForm(form(), {
        hasStoredSecret: false,
        existingNames: new Set(["bifrost"]),
        stage: "save",
      }),
    ).toMatch(/already exists/);
  });

  it("refuses a base URL that is not a URL", () => {
    expect(
      validateForm(form({ baseURL: "bifrost.internal" }), {
        hasStoredSecret: false,
        existingNames: NO_NAMES,
        stage: "save",
      }),
    ).toBe("Base URL must start with http:// or https://.");
  });

  /**
   * Probing is how models get chosen, so requiring them first would be
   * circular — and a gateway saved with none produces an empty picker with
   * nothing to explain it, which is why saving does require them.
   */
  it("lets a model-less form be probed but not saved", () => {
    const bare = form({ modelIds: "" });
    const options = { hasStoredSecret: false, existingNames: NO_NAMES } as const;
    expect(validateForm(bare, { ...options, stage: "probe" })).toBeNull();
    expect(validateForm(bare, { ...options, stage: "save" })).toMatch(/at least one model/i);
  });
});

describe("the draft loop receives", () => {
  it("lowercases the name, trims, and omits empty headers", () => {
    expect(buildDraft(form({ name: "  BiFrost " }), { hasStoredSecret: false, withModels: true })).toEqual({
      name: "bifrost",
      sdk: "anthropic",
      baseURL: "http://bifrost.internal/anthropic",
      auth: { kind: "apikey", apiKey: "sk-live" },
      models: [{ id: "claude-opus-5" }],
    });
  });

  it("omits models while only probing, so discovery need not know them yet", () => {
    const draft = buildDraft(form(), { hasStoredSecret: false, withModels: false });
    expect(draft.models).toBeUndefined();
  });

  it("sends oauth options only when the user overrode discovery", () => {
    expect(resolveAuth(form({ authKind: "oauth" }), false)).toEqual({ kind: "oauth" });
    expect(resolveAuth(form({ authKind: "oauth", oauthScopes: "openid offline_access" }), false)).toEqual({
      kind: "oauth",
      oauth: { scopes: ["openid", "offline_access"] },
    });
  });
});

describe("editing a saved gateway", () => {
  const summary: CustomProviderSummary = {
    id: "custom:bifrost",
    name: "bifrost",
    sdk: "openai",
    baseURL: "http://bifrost.internal/openai",
    authKind: "env",
    authDescription: "env $BIFROST_KEY",
    hasStoredSecret: false,
    envVar: "BIFROST_KEY",
    hasOAuthSession: false,
    headers: { "X-Virtual-Key": "vk-1" },
    models: [{ id: "gpt-5.6-luna", name: "Luna" }],
  };

  it("round-trips what loop reported back into the form", () => {
    const state = formStateFrom(summary);
    expect(state).toMatchObject({
      name: "bifrost",
      sdk: "openai",
      authKind: "env",
      envVar: "BIFROST_KEY",
      headers: "X-Virtual-Key: vk-1",
      modelIds: "gpt-5.6-luna",
    });
    // The discovered metadata rides along, so an untouched save does not reset
    // the model's name to its bare id.
    expect(resolveModels(state)).toEqual([{ id: "gpt-5.6-luna", name: "Luna" }]);
  });
});
