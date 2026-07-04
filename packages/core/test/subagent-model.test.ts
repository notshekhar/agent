import { describe, expect, test } from "bun:test";
import { resolveSubagentModel } from "../src/agent/subagent";

const catalog = {
    "anthropic/claude-opus-4-8": { available: true },
    "openai/gpt-5-mini": { available: true },
    "google/gemini-3-pro": { available: false },
};

const parent = "anthropic/claude-opus-4-8";

describe("resolveSubagentModel", () => {
    test("nothing configured → inherit the parent's model, no warning", () => {
        const r = resolveSubagentModel({ parentModelId: parent, catalog });
        expect(r).toEqual({ modelId: parent });
    });

    test("agent file model wins over the subagentModel setting", () => {
        const r = resolveSubagentModel({
            agentModel: "openai/gpt-5-mini",
            settingModel: "google/gemini-3-pro",
            parentModelId: parent,
            catalog,
        });
        expect(r.modelId).toBe("openai/gpt-5-mini");
        expect(r.warning).toBeUndefined();
    });

    test("setting applies when the agent has no model of its own", () => {
        const r = resolveSubagentModel({ settingModel: "openai/gpt-5-mini", parentModelId: parent, catalog });
        expect(r.modelId).toBe("openai/gpt-5-mini");
    });

    test("cross-provider selection is allowed (the whole point)", () => {
        const r = resolveSubagentModel({ agentModel: "openai/gpt-5-mini", parentModelId: parent, catalog });
        expect(r.modelId).toBe("openai/gpt-5-mini");
    });

    test("unknown model fails SOFT to the parent with a warning", () => {
        const r = resolveSubagentModel({ agentModel: "nope/not-a-model", parentModelId: parent, catalog });
        expect(r.modelId).toBe(parent);
        expect(r.warning).toContain("nope/not-a-model");
        expect(r.warning).toContain(parent);
    });

    test("unavailable model (provider logged out) fails SOFT to the parent", () => {
        const r = resolveSubagentModel({ settingModel: "google/gemini-3-pro", parentModelId: parent, catalog });
        expect(r.modelId).toBe(parent);
        expect(r.warning).toContain("not available");
    });

    test("configured == parent is a silent no-op", () => {
        const r = resolveSubagentModel({ agentModel: parent, parentModelId: parent, catalog });
        expect(r).toEqual({ modelId: parent });
    });

    test("whitespace-only values are treated as unset", () => {
        const r = resolveSubagentModel({ agentModel: "  ", settingModel: "", parentModelId: parent, catalog });
        expect(r).toEqual({ modelId: parent });
    });

    test("agent model invalid does NOT fall through to the setting — parent wins", () => {
        // Deliberate: a stale agent file shouldn't silently reroute to the
        // global setting; the parent model is the predictable fallback.
        const r = resolveSubagentModel({
            agentModel: "nope/gone",
            settingModel: "openai/gpt-5-mini",
            parentModelId: parent,
            catalog,
        });
        expect(r.modelId).toBe(parent);
        expect(r.warning).toBeDefined();
    });
});
