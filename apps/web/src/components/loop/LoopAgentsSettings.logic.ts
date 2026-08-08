/**
 * Agent-editor rules, kept out of the component so they can be tested.
 *
 * The subtle one is the tool allowlist. loop stores "every tool" as the
 * ABSENCE of a `tools:` line, not as a list containing everything — so a form
 * that always sent an explicit list would silently pin an agent to the tools
 * that existed the day it was saved, and a tool added by a later loop (or by
 * an extension) would never reach it.
 */
import type { LoopAgent, LoopAgentDetail } from "../../loop/agents";

/** loop's own rule (`isValidAgentName`): the name becomes both a filename and
 * a `/command`, so anything path-like or spaced is refused rather than
 * sanitized into a different agent than the one the user typed. */
const AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,31}$/;

export function agentNameError(name: string, existing: readonly LoopAgent[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give the agent a name.";
  if (!AGENT_NAME_PATTERN.test(trimmed)) {
    return "Letters, numbers and dashes only, up to 32 characters.";
  }
  if (existing.some((agent) => agent.name === trimmed)) return `"${trimmed}" already exists.`;
  return null;
}

/**
 * The `tools` value to send for a selection.
 *
 * `undefined` means "every tool", which is also what loop infers from a
 * complete list — so a fully-checked form and an untouched one agree, and
 * neither freezes the agent against tools loop gains later.
 */
export function toolsForSave(
  selected: readonly string[],
  available: readonly string[],
): readonly string[] | undefined {
  if (selected.length === 0) return undefined;
  const kept = available.filter((tool) => selected.includes(tool));
  return kept.length === available.length ? undefined : kept;
}

/** What a tool checklist starts as: an agent's own allowlist, or everything
 * when it has none (that is what "all tools" means). */
export function initialToolSelection(
  agent: Pick<LoopAgentDetail, "tools">,
  available: readonly string[],
): readonly string[] {
  return agent.tools === undefined ? [...available] : available.filter((tool) => agent.tools?.includes(tool));
}

export interface AgentDraft {
  readonly name: string;
  readonly prompt: string;
  readonly tools: readonly string[];
  /** "" = inherit the session's model. */
  readonly model: string;
}

export function draftFromAgent(agent: LoopAgentDetail, available: readonly string[]): AgentDraft {
  return {
    name: agent.name,
    prompt: agent.prompt,
    tools: initialToolSelection(agent, available),
    model: agent.model ?? "",
  };
}

/** Whether Save should do anything. Compared against the loaded agent rather
 * than tracked with a flag, so undoing an edit by hand also disarms it. */
export function isDraftDirty(draft: AgentDraft, agent: LoopAgentDetail, available: readonly string[]): boolean {
  const original = draftFromAgent(agent, available);
  return (
    draft.prompt.trim() !== original.prompt.trim() ||
    draft.model.trim() !== original.model.trim() ||
    // Order is not meaningful — loop writes the allowlist in its own order.
    [...draft.tools].sort().join(",") !== [...original.tools].sort().join(",")
  );
}

/**
 * Agents in the order the panel lists them: custom first, then built-ins.
 *
 * The user's own agents are what they came to edit; the built-ins are
 * reference material they can override but did not create.
 */
export function sortAgentsForPanel(agents: readonly LoopAgent[]): readonly LoopAgent[] {
  return [...agents].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** One line describing an agent's reach, for the list row. */
export function toolsSummary(agent: Pick<LoopAgent, "tools">): string {
  if (agent.tools === undefined) return "All tools";
  if (agent.tools.length === 0) return "No tools";
  return agent.tools.join(", ");
}
