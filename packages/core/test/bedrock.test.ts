import { describe, expect, test } from "bun:test";
import { bedrockShortModelId } from "../src/providers/bedrock";

describe("bedrockShortModelId", () => {
    test("strips geo prefix, vendor segment, and version suffix", () => {
        expect(bedrockShortModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5-20250929");
        expect(bedrockShortModelId("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe("claude-3-5-sonnet-20241022");
        expect(bedrockShortModelId("eu.meta.llama3-2-90b-instruct-v1:0")).toBe("llama3-2-90b-instruct");
        expect(bedrockShortModelId("us-gov.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
            "claude-haiku-4-5-20251001",
        );
        expect(bedrockShortModelId("global.anthropic.claude-opus-4-6-v1")).toBe("claude-opus-4-6");
        expect(bedrockShortModelId("mistral.mistral-large-2402-v1:0")).toBe("mistral-large-2402");
        expect(bedrockShortModelId("amazon.nova-pro-v1:0")).toBe("nova-pro");
    });

    test("leaves ids without vendor/version decoration alone", () => {
        expect(bedrockShortModelId("some-model")).toBe("some-model");
    });
});
