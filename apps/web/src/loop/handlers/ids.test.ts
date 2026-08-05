import { describe, expect, it } from "vite-plus/test";

import { fromInstanceId, toInstanceId, UNKNOWN_PROVIDER_INSTANCE_ID } from "./ids.ts";

const SLUG = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

describe("provider id translation", () => {
  it("passes plain loop ids through untouched", () => {
    for (const id of ["kimi", "openai-chatgpt", "xai", "deepseek"]) {
      expect(toInstanceId(id)).toBe(id);
      expect(fromInstanceId(toInstanceId(id))).toBe(id);
    }
  });

  it("encodes the colon the contract rejects, and round-trips it", () => {
    expect(toInstanceId("custom:pronto-gpt")).toBe("custom__pronto-gpt");
    expect(fromInstanceId("custom__pronto-gpt")).toBe("custom:pronto-gpt");
  });

  it("produces ids the contract's slug pattern accepts", () => {
    // The real provider list from a running loop, including the ones that
    // silently vanished from the config before this translation existed.
    const loopProviders = [
      "openrouter",
      "openai-chatgpt",
      "zenmux",
      "deepseek",
      "anthropic",
      "kimi",
      "xai",
      "custom:pronto-claude",
      "custom:pronto-gpt",
      "ollama",
    ];
    for (const id of loopProviders) {
      expect(toInstanceId(id)).toMatch(SLUG);
      expect(fromInstanceId(toInstanceId(id))).toBe(id);
    }
  });

  it("maps unrepresentable ids to the reserved slug instead of throwing", () => {
    // Sessions on disk really do carry these.
    expect(toInstanceId("")).toBe(UNKNOWN_PROVIDER_INSTANCE_ID);
    expect(toInstanceId("   ")).toBe(UNKNOWN_PROVIDER_INSTANCE_ID);
    expect(toInstanceId("9lives")).toBe(UNKNOWN_PROVIDER_INSTANCE_ID);
    expect(fromInstanceId(UNKNOWN_PROVIDER_INSTANCE_ID)).toBe("");
  });
});
