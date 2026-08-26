import { describe, expect, test } from "bun:test";
import { getAgentTools, isReadOnlyBashAgent, isValidAgentName, parseAgentFile } from "../src/agent/agents";
import { isSandboxSupported } from "@notshekhar/loop-sandbox";

describe("plan agent tools", () => {
    test("includes bash only where the OS sandbox can enforce read-only", () => {
        const tools = getAgentTools("plan")!;
        expect(tools).toContain("read");
        expect(tools).not.toContain("write");
        expect(tools).not.toContain("edit");
        expect(tools.includes("bash")).toBe(isSandboxSupported());
    });

    test("includes skill (read-only skill loading)", () => {
        expect(getAgentTools("plan")!).toContain("skill");
    });
});

describe("isReadOnlyBashAgent", () => {
    test("true when bash is allowed but write/edit are not", () => {
        expect(isReadOnlyBashAgent(["read", "bash"])).toBe(true);
    });
    test("false when write or edit is allowed", () => {
        expect(isReadOnlyBashAgent(["bash", "write"])).toBe(false);
        expect(isReadOnlyBashAgent(["bash", "edit"])).toBe(false);
    });
    test("false without bash, and false for all-tools (undefined)", () => {
        expect(isReadOnlyBashAgent(["read", "grep"])).toBe(false);
        expect(isReadOnlyBashAgent(undefined)).toBe(false);
    });
});

describe("isValidAgentName", () => {
    test("accepts slash-command-safe names", () => {
        expect(isValidAgentName("reviewer")).toBe(true);
        expect(isValidAgentName("my-agent_2")).toBe(true);
        expect(isValidAgentName("A1")).toBe(true);
    });

    test("rejects unsafe names", () => {
        expect(isValidAgentName("")).toBe(false);
        expect(isValidAgentName("-leading-dash")).toBe(false);
        expect(isValidAgentName("has space")).toBe(false);
        expect(isValidAgentName("a".repeat(33))).toBe(false);
        expect(isValidAgentName("path/em")).toBe(false);
    });
});

describe("parseAgentFile", () => {
    test("plain body, no frontmatter", () => {
        expect(parseAgentFile("You are a reviewer.\n")).toEqual({ prompt: "You are a reviewer." });
    });

    test("frontmatter with tools subset", () => {
        const parsed = parseAgentFile("---\ntools: read, grep\n---\n\nReview only.\n");
        expect(parsed.prompt).toBe("Review only.");
        expect(parsed.tools).toEqual(["read", "grep"]);
    });

    test("unknown tools are dropped; empty result means all tools", () => {
        const parsed = parseAgentFile("---\ntools: hammer, saw\n---\n\nBody.");
        expect(parsed.tools).toBeUndefined();
    });

    test("full tool list (incl. task + ask + websearch + plan + todo + skill) normalizes to undefined (= all)", () => {
        const parsed = parseAgentFile(
            "---\ntools: read, write, edit, bash, ls, grep, find, sql, task, ask, websearch, plan, todo, skill\n---\n\nBody.",
        );
        expect(parsed.tools).toBeUndefined();
    });

    test("a pre-artifact full list still means all tools, with or without artifact named", () => {
        // Agent files written before the artifact tool existed enumerate the
        // older set. They must keep normalizing to unrestricted: a demotion to
        // "restricted" would quietly cut them off from MCP and extension tools.
        const withArtifact = parseAgentFile(
            "---\ntools: read, write, edit, bash, ls, grep, find, sql, task, ask, websearch, plan, todo, skill, artifact\n---\n\nBody.",
        );
        expect(withArtifact.tools).toBeUndefined();
    });

    test("a pre-shells full list still means all tools", () => {
        // Same guarantee as the artifact case above, for the tool that came
        // with background shells: an agent file that enumerated the set before
        // `shells` existed must not be demoted to restricted.
        const parsed = parseAgentFile(
            "---\ntools: read, write, edit, bash, ls, grep, find, sql, task, ask, websearch, plan, todo, skill, artifact\n---\n\nBody.",
        );
        expect(parsed.tools).toBeUndefined();
    });

    test("shells is a valid agent tool", () => {
        const parsed = parseAgentFile("---\ntools: read, bash, shells\n---\n\nBody.");
        expect(parsed.tools).toEqual(["read", "bash", "shells"]);
    });

    test("artifact is a valid agent tool", () => {
        const parsed = parseAgentFile("---\ntools: read, write, artifact\n---\n\nBody.");
        expect(parsed.tools).toEqual(["read", "write", "artifact"]);
    });

    test("skill is a valid agent tool", () => {
        const parsed = parseAgentFile("---\ntools: read, grep, skill\n---\n\nBody.");
        expect(parsed.tools).toEqual(["read", "grep", "skill"]);
    });

    test("todo is a valid agent tool", () => {
        const parsed = parseAgentFile("---\ntools: read, grep, todo\n---\n\nBody.");
        expect(parsed.tools).toEqual(["read", "grep", "todo"]);
    });

    test("plan is a valid agent tool", () => {
        const parsed = parseAgentFile("---\ntools: read, grep, plan\n---\n\nBody.");
        expect(parsed.tools).toEqual(["read", "grep", "plan"]);
    });

    test("ask is a valid agent tool", () => {
        const parsed = parseAgentFile("---\ntools: read, grep, ask\n---\n\nBody.");
        expect(parsed.tools).toEqual(["read", "grep", "ask"]);
    });

    test("file tools without task stays explicit (= no subagents)", () => {
        const parsed = parseAgentFile("---\ntools: read, write, edit, bash, ls, grep, find\n---\n\nBody.");
        expect(parsed.tools).toEqual(["read", "write", "edit", "bash", "ls", "grep", "find"]);
    });

    test("task is a valid agent tool", () => {
        const parsed = parseAgentFile("---\ntools: read, grep, task\n---\n\nBody.");
        expect(parsed.tools).toEqual(["read", "grep", "task"]);
    });

    test("legacy subagent-tools line is ignored (subagents fork the active agent now)", () => {
        const parsed = parseAgentFile("---\ntools: read, task\nsubagent-tools: read, grep, task\n---\n\nBody.");
        expect(parsed.tools).toEqual(["read", "task"]);
        expect(parsed).not.toHaveProperty("subagentTools");
        expect(parsed.prompt).toBe("Body.");
    });

    test("frontmatter without tools line keeps prompt", () => {
        const parsed = parseAgentFile("---\nname: x\n---\n\nThe prompt.");
        expect(parsed.prompt).toBe("The prompt.");
        expect(parsed.tools).toBeUndefined();
    });
});

describe("parseAgentFile model", () => {
    test("model line is parsed alongside tools", () => {
        const parsed = parseAgentFile("---\ntools: read, grep\nmodel: openai/gpt-5-mini\n---\n\nReview only.");
        expect(parsed.tools).toEqual(["read", "grep"]);
        expect(parsed.model).toBe("openai/gpt-5-mini");
        expect(parsed.prompt).toBe("Review only.");
    });

    test("model line alone (no tools) works", () => {
        const parsed = parseAgentFile("---\nmodel: anthropic/claude-haiku-4-5\n---\n\nBody.");
        expect(parsed.model).toBe("anthropic/claude-haiku-4-5");
        expect(parsed.tools).toBeUndefined();
    });

    test("no model line = inherit (undefined)", () => {
        expect(parseAgentFile("---\ntools: read\n---\n\nBody.").model).toBeUndefined();
        expect(parseAgentFile("Plain body.").model).toBeUndefined();
    });

    test("model value is kept unvalidated (catalog check happens at spawn)", () => {
        const parsed = parseAgentFile("---\nmodel: someprovider/not-in-catalog\n---\n\nBody.");
        expect(parsed.model).toBe("someprovider/not-in-catalog");
    });

    test("whitespace-only model is treated as unset", () => {
        expect(parseAgentFile("---\nmodel:   \n---\n\nBody.").model).toBeUndefined();
    });
});
