import { describe, expect, it } from "vite-plus/test";

import {
  agentNameError,
  draftFromAgent,
  initialToolSelection,
  isDraftDirty,
  sortAgentsForPanel,
  toolsForSave,
  toolsSummary,
} from "./LoopAgentsSettings.logic.ts";

const AVAILABLE = ["read", "write", "edit", "bash", "task"];

const agent = (over: Partial<Parameters<typeof draftFromAgent>[0]> = {}) => ({
  name: "reviewer",
  prompt: "You review code.",
  builtin: false,
  toolsEditable: true,
  hasOverride: false,
  ...over,
});

describe("naming an agent", () => {
  it("refuses what loop would refuse, before the round trip", () => {
    expect(agentNameError("", [])).toContain("name");
    expect(agentNameError("../escape", [])).toContain("Letters");
    expect(agentNameError("has space", [])).toContain("Letters");
    expect(agentNameError("-leading", [])).toContain("Letters");
    expect(agentNameError("a".repeat(33), [])).toContain("Letters");
  });

  it("accepts the shapes loop accepts", () => {
    expect(agentNameError("reviewer", [])).toBeNull();
    expect(agentNameError("data-analyst-2", [])).toBeNull();
  });

  it("refuses a name already taken, so saving cannot silently overwrite", () => {
    const existing = [{ name: "plan", builtin: true }];
    expect(agentNameError("plan", existing)).toContain("already exists");
    expect(agentNameError("planner", existing)).toBeNull();
  });
});

describe("the tool allowlist", () => {
  it("sends nothing when everything is checked, so later tools are included", () => {
    // loop stores "all tools" as the absence of a tools: line. Writing the
    // full list instead would freeze the agent against the tools that existed
    // the day it was saved — including ones extensions add later.
    expect(toolsForSave(AVAILABLE, AVAILABLE)).toBeUndefined();
  });

  it("sends the subset when it is a subset", () => {
    expect(toolsForSave(["read", "bash"], AVAILABLE)).toEqual(["read", "bash"]);
  });

  it("drops a tool this loop does not have", () => {
    expect(toolsForSave(["read", "ghost"], AVAILABLE)).toEqual(["read"]);
  });

  it("treats an empty selection as all tools rather than a mute agent", () => {
    expect(toolsForSave([], AVAILABLE)).toBeUndefined();
  });

  it("starts a checklist from the agent's own list, or everything", () => {
    expect(initialToolSelection({ tools: ["read", "bash"] }, AVAILABLE)).toEqual(["read", "bash"]);
    // An absent allowlist IS "all tools" — that is how loop stores it.
    expect(initialToolSelection({}, AVAILABLE)).toEqual(AVAILABLE);
  });
});

describe("when Save is armed", () => {
  it("is disarmed for an untouched draft", () => {
    const loaded = agent({ tools: ["read"] });
    expect(isDraftDirty(draftFromAgent(loaded, AVAILABLE), loaded, AVAILABLE)).toBe(false);
  });

  it("notices a changed prompt, model or tool set", () => {
    const loaded = agent({ tools: ["read"] });
    const base = draftFromAgent(loaded, AVAILABLE);
    expect(isDraftDirty({ ...base, prompt: "Something else" }, loaded, AVAILABLE)).toBe(true);
    expect(isDraftDirty({ ...base, model: "openai/gpt-5-mini" }, loaded, AVAILABLE)).toBe(true);
    expect(isDraftDirty({ ...base, tools: ["read", "bash"] }, loaded, AVAILABLE)).toBe(true);
  });

  it("ignores tool order and surrounding whitespace", () => {
    // loop writes the allowlist in its own order, so a reordered selection is
    // the same agent — and re-arming Save on it would show a phantom change.
    const loaded = agent({ tools: ["read", "bash"] });
    const base = draftFromAgent(loaded, AVAILABLE);
    expect(isDraftDirty({ ...base, tools: ["bash", "read"] }, loaded, AVAILABLE)).toBe(false);
    expect(isDraftDirty({ ...base, prompt: `\n${base.prompt}  ` }, loaded, AVAILABLE)).toBe(false);
  });
});

describe("how the panel lists agents", () => {
  it("puts the user's own agents above the built-ins", () => {
    const listed = sortAgentsForPanel([
      { name: "plan", builtin: true },
      { name: "reviewer", builtin: false },
      { name: "default", builtin: true },
      { name: "annotator", builtin: false },
    ]);
    expect(listed.map((a) => a.name)).toEqual(["annotator", "reviewer", "default", "plan"]);
  });

  it("says what an agent can reach", () => {
    expect(toolsSummary({})).toBe("All tools");
    expect(toolsSummary({ tools: ["read", "grep"] })).toBe("read, grep");
    expect(toolsSummary({ tools: [] })).toBe("No tools");
  });
});
