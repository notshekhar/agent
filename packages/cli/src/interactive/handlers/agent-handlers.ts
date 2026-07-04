/**
 * Agent management: /agents and one-shot /<agent> <message>.
 */
import type { SelectItem } from "@notshekhar/loop-tui";
import chalk from "chalk";
import {
    AGENT_TOOL_NAMES,
    DEFAULT_AGENT_NAME,
    DEFAULT_BASE_PROMPT,
    agentExists,
    deleteAgent,
    getAgentModel,
    getAgentPrompt,
    getAgentTools,
    getCatalog,
    hasBuiltinOverride,
    isHiddenAgent,
    isValidAgentName,
    listAgents,
    registerAgentCommand,
    saveAgent,
    settingsStore,
    type CommandContext,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";

type AgentHandlers = Pick<CommandContext, "useAgent" | "manageAgents">;

export function createAgentHandlers(state: AppState, deps: AppDeps): AgentHandlers {
    const {
        tui,
        history,
        statusLine,
        editor,
        commands,
        selectOnce,
        searchOnce,
        toggleOnce,
        promptOnce,
        refreshCommands,
    } = deps;

    return {
        useAgent(name, message) {
            if (!agentExists(name)) {
                history.addSystem(chalk.red(`unknown agent: ${name} — /agents to create one`));
                tui.requestRender();
                return;
            }
            // /<agent> <message> = one-shot: that message runs under this agent's
            // prompt; the session's selected agent is untouched. Switching the
            // session agent happens only via /agents → use.
            if (message?.trim()) {
                state.oneShotAgent = name;
                history.addSystem(chalk.dim(`agent for this message: ${name}`));
                tui.requestRender();
                if (editor.onSubmit) void editor.onSubmit(message);
                return;
            }
            history.addSystem(`usage: /${name} <message> — one message with this agent. Session switch: /agents`);
            tui.requestRender();
        },
        async manageAgents() {
            const toolsLabel = (tools: string[] | undefined) => (tools?.length ? tools.join(", ") : "all tools");
            // Toggle multi-select (cursor stays put, Enter/Space toggles).
            // Returns undefined = all tools, null = cancelled.
            const pickFrom = async (
                all: string[],
                initial: string[] | undefined,
                title: string,
            ): Promise<string[] | undefined | null> => {
                const picked = await toggleOnce(all, new Set(initial?.length ? initial : all), title);
                if (picked === null) return null;
                return picked.length === all.length ? undefined : picked;
            };
            // Agent tools include "task" (subagents). No separate subagent
            // config: a subagent forks the spawning turn's agent and is always
            // capped to its tools, so delegation can never widen access.
            const pickTools = (initial: string[] | undefined) =>
                pickFrom([...AGENT_TOOL_NAMES], initial, "Agent tools (task = can spawn subagents)");
            const modelLabel = (model: string | undefined) => model ?? "inherit";
            // Model this agent runs on as a subagent. Cross-provider on purpose
            // (the whole point: drive on one model, fan out on a cheaper one).
            // Returns undefined = inherit, null = cancelled.
            const pickModel = async (current: string | undefined): Promise<string | undefined | null> => {
                const INHERIT = "\x00inherit";
                const cat = await getCatalog();
                const items: SelectItem[] = [
                    {
                        value: INHERIT,
                        label: "inherit (session model)",
                        description: current ? "clear the override" : "(current)",
                    },
                    ...Object.values(cat)
                        .filter((m) => m.available)
                        .sort((a, b) => a.id.localeCompare(b.id))
                        .map((m) => ({
                            value: m.id,
                            label: m.id + (m.id === current ? "  (current)" : ""),
                            description: `${m.name}  ·  ctx ${m.contextWindow.toLocaleString()}  ·  $${m.cost.input}/$${m.cost.output}`,
                        })),
                ];
                const pick = await searchOnce(items, "Subagent model for this agent (type to filter)");
                if (!pick) return null;
                return pick.value === INHERIT ? undefined : pick.value;
            };

            // Loop so Esc in submenus returns to the agent list, like /settings.
            let lastIndex = 0;
            while (true) {
                const agents = listAgents();
                const items: SelectItem[] = [
                    {
                        value: "+new",
                        label: "+ new agent",
                        description: "create an agent with its own tools and system prompt",
                    },
                    ...agents.map((a) => ({
                        value: a.name,
                        label:
                            a.name + (a.name === state.agent ? "  (active)" : "") + (a.builtin ? "  [built-in]" : ""),
                        description: `[${toolsLabel(a.tools)}]${a.model ? ` [${a.model}]` : ""} ${a.prompt.split("\n")[0].slice(0, 60)}`,
                    })),
                ];
                const pick = await selectOnce(items, "Agents (Esc to close)", { initialIndex: lastIndex });
                if (!pick) return;
                lastIndex = Math.max(
                    0,
                    items.findIndex((i) => i.value === pick.value),
                );

                if (pick.value === "+new") {
                    const name = (await promptOnce("agent name (e.g. reviewer)")).trim();
                    if (!name) continue;
                    if (!isValidAgentName(name)) {
                        history.addSystem(chalk.red(`invalid name: ${name} (alphanumeric, dashes, ≤32 chars)`));
                        tui.requestRender();
                        continue;
                    }
                    if (agentExists(name) || commands.has(name)) {
                        history.addSystem(chalk.red(`"${name}" already exists (agent or command)`));
                        tui.requestRender();
                        continue;
                    }
                    // Tools first, then model, then the prompt — the prompt can
                    // reference what's allowed.
                    const tools = await pickTools(undefined);
                    if (tools === null) continue;
                    const model = await pickModel(undefined);
                    if (model === null) continue;
                    const prompt = await promptOnce(
                        `system prompt for "${name}" [${toolsLabel(tools)}]`,
                        DEFAULT_BASE_PROMPT,
                    );
                    if (!prompt.trim()) continue;
                    saveAgent(name, prompt, tools, model);
                    registerAgentCommand(commands, name);
                    refreshCommands();
                    history.addSystem(
                        `agent "${name}" created [${toolsLabel(tools)}]${model ? ` on ${model}` : ""} — /${name} <message> for one message, /agents → use for the session`,
                    );
                    tui.requestRender();
                    continue;
                }

                const name = pick.value;
                const info = agents.find((a) => a.name === name);
                const isBuiltin = info?.builtin ?? false;
                const currentTools = getAgentTools(name);
                const currentModel = getAgentModel(name);
                const actions: SelectItem[] = [
                    { value: "use", label: "use", description: `switch active agent to "${name}"` },
                    { value: "edit", label: "edit prompt", description: "edit this agent's system prompt" },
                    {
                        value: "model",
                        label: `model: ${modelLabel(currentModel)}`,
                        description: "model this agent runs on as a subagent — inherit = the session model",
                    },
                ];
                if (isBuiltin) {
                    // Built-in tool sets are fixed — preview only, no edit.
                    actions.push({
                        value: "tools-view",
                        label: "tools (fixed)",
                        description: toolsLabel(currentTools),
                    });
                    if (hasBuiltinOverride(name)) {
                        actions.push({
                            value: "delete",
                            label: "reset to built-in",
                            description: "remove the prompt override",
                        });
                    }
                } else {
                    actions.push({
                        value: "tools",
                        label: "edit tools",
                        description: `current: ${toolsLabel(currentTools)}`,
                    });
                    actions.push({ value: "delete", label: "delete", description: "remove agent and its /command" });
                }
                const action = await selectOnce(
                    actions,
                    `Agent: ${name} [${toolsLabel(currentTools)}]${currentModel ? ` · ${currentModel}` : ""}`,
                );
                if (!action) continue;

                if (action.value === "use") {
                    state.agent = name;
                    settingsStore.set("agent", name);
                    statusLine.setAgent(name);
                    // Custom agents — and hidden built-ins like data-analyst —
                    // join the Tab cycle once explicitly selected.
                    if (!isBuiltin || isHiddenAgent(name)) state.cycleCustomAgent = name;
                    history.addSystem(`agent → ${name}`);
                    tui.requestRender();
                    return;
                }
                if (action.value === "tools-view") {
                    history.addSystem(`agent "${name}" tools (fixed): ${toolsLabel(currentTools)}`);
                    tui.requestRender();
                    continue;
                }
                if (action.value === "tools") {
                    const tools = await pickTools(currentTools);
                    if (tools === null) continue;
                    saveAgent(name, getAgentPrompt(name) ?? DEFAULT_BASE_PROMPT, tools, currentModel);
                    history.addSystem(`agent "${name}" tools → ${toolsLabel(tools)}`);
                    tui.requestRender();
                    continue;
                }
                if (action.value === "model") {
                    const model = await pickModel(currentModel);
                    if (model === null) continue;
                    saveAgent(name, getAgentPrompt(name) ?? DEFAULT_BASE_PROMPT, currentTools, model);
                    history.addSystem(`agent "${name}" model → ${modelLabel(model)}`);
                    tui.requestRender();
                    continue;
                }
                if (action.value === "edit") {
                    const current = getAgentPrompt(name) ?? DEFAULT_BASE_PROMPT;
                    // Built-ins: tools are fixed but still previewed before editing.
                    if (isBuiltin) {
                        history.addSystem(chalk.dim(`tools (fixed): ${toolsLabel(currentTools)}`));
                        tui.requestRender();
                    }
                    const edited = await promptOnce(
                        `system prompt for "${name}" [${toolsLabel(currentTools)}]`,
                        current,
                    );
                    if (!edited.trim() || edited.trim() === current.trim()) continue;
                    saveAgent(name, edited, currentTools, currentModel);
                    history.addSystem(`agent "${name}" prompt updated`);
                    tui.requestRender();
                    continue;
                }
                if (action.value === "delete") {
                    deleteAgent(name);
                    // Resetting a hidden built-in's prompt override leaves the
                    // agent itself intact, so keep it revealed in the cycle.
                    if (state.cycleCustomAgent === name && !isHiddenAgent(name)) state.cycleCustomAgent = null;
                    if (state.agent === name && !isBuiltin) {
                        state.agent = DEFAULT_AGENT_NAME;
                        settingsStore.set("agent", DEFAULT_AGENT_NAME);
                        statusLine.setAgent(DEFAULT_AGENT_NAME);
                    }
                    if (!isBuiltin) commands.unregister(name);
                    refreshCommands();
                    history.addSystem(isBuiltin ? `"${name}" prompt reset to built-in` : `agent "${name}" deleted`);
                    tui.requestRender();
                    continue;
                }
            }
        },
    };
}
