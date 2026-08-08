/**
 * loop's agents, for the composer picker and the settings editor.
 *
 * An agent is a named prompt (plus an optional tool allowlist and model) that
 * a turn can run under — `/<agent> <message>` in the terminal. loop keeps them
 * as markdown files under its config dir and exposes them over RPC; nothing
 * about them is per-session, so these are plain reads and writes.
 *
 * Two reads, deliberately: `agent.list` withholds the prompt because it can be
 * pages long and a picker only needs names, while `agent.get` carries it
 * because editing it is the point.
 */
import { loopCall } from "./transport.ts";

export interface LoopAgent {
  readonly name: string;
  readonly builtin: boolean;
  /** Full provider/model id this agent runs on; absent = inherit. */
  readonly model?: string;
  /** Allowed tool names; absent = every tool. */
  readonly tools?: readonly string[];
}

export interface LoopAgentDetail extends LoopAgent {
  readonly prompt: string;
  /** False for built-ins, whose tool sets are fixed — only the prompt and
   * model are editable. */
  readonly toolsEditable: boolean;
  /** A built-in whose prompt has been overridden, i.e. one that can be reset. */
  readonly hasOverride: boolean;
}

function isAgent(value: unknown): value is LoopAgent {
  return typeof value === "object" && value !== null && typeof (value as LoopAgent).name === "string";
}

/** Empty when loop is older than `agent.list` — a picker then has nothing to
    offer, which is the right outcome rather than a broken panel. */
export async function listAgents(cwd?: string): Promise<readonly LoopAgent[]> {
  const listed = await loopCall<unknown>("agent.list", {}, cwd).catch(() => []);
  if (!Array.isArray(listed)) return [];
  return listed.filter(isAgent);
}

/**
 * One agent, prompt included. Throws on an unknown name — the editor opens
 * from a list, so a miss means the agent was deleted underneath it and a
 * blank form would silently create a second one on save.
 */
export async function getAgent(name: string, cwd?: string): Promise<LoopAgentDetail> {
  const agent = await loopCall<unknown>("agent.get", { name }, cwd);
  if (!isAgent(agent)) throw new Error(`loop did not return an agent for "${name}"`);
  const detail = agent as LoopAgentDetail;
  return { ...detail, prompt: typeof detail.prompt === "string" ? detail.prompt : "" };
}

export interface SaveAgentInput {
  readonly name: string;
  readonly prompt: string;
  /** Omit for "every tool". A built-in's tools are fixed and ignored here. */
  readonly tools?: readonly string[] | undefined;
  /** Full provider/model id, or omit to inherit the session's model. */
  readonly model?: string | undefined;
}

/** Create or update. loop validates the name and refuses an empty prompt, so
    the error surfaced here is loop's own wording. */
export async function saveAgent(input: SaveAgentInput, cwd?: string): Promise<void> {
  await loopCall<unknown>(
    "agent.save",
    {
      name: input.name,
      prompt: input.prompt,
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      ...(input.model === undefined || input.model === "" ? {} : { model: input.model }),
    },
    cwd,
  );
}

/**
 * Remove a custom agent, or reset a built-in's prompt override.
 *
 * `false` means there was no file to remove — already gone, not a failure.
 */
export async function deleteAgent(name: string, cwd?: string): Promise<boolean> {
  const result = await loopCall<{ ok?: boolean }>("agent.delete", { name }, cwd);
  return result?.ok === true;
}

/**
 * Tool names an agent allowlist may contain. Asked of loop rather than
 * hardcoded because extensions register tools too (loop's LSP extension adds
 * `lsp`), and an editor that could not offer them would quietly drop one from
 * an agent it re-saved.
 */
export async function listAgentTools(cwd?: string): Promise<readonly string[]> {
  const tools = await loopCall<unknown>("agent.tools", {}, cwd).catch(() => []);
  return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === "string") : [];
}
