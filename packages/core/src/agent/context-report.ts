/**
 * /context — per-category estimate of what fills the model's context window.
 *
 * Mirrors runTurn's assembly (same settings/trust gating, same helpers) but
 * read-only: nothing here connects, persists, or mutates. All numbers use the
 * chars/4 heuristic from model-messages.ts — providers only ever report one
 * total, so a breakdown is necessarily an estimate.
 */
import { getCatalog } from "../catalog";
import { getSetting } from "../settings";
import { getMcpManager, isMcpEnabled } from "../mcp";
import { getExtensionHost } from "../extensions";
import { createTools } from "../tools";
import type { Session } from "../sessions";
import { getAgentPrompt, getAgentTools, listAgents } from "./agents";
import { loadWorkspaceContext } from "./context";
import { loadMemoryContext } from "./memory";
import { loadProjectSkills } from "./skills";
import { isTrusted } from "./trust";
import { buildSubagentNote, buildSystemPrompt } from "./system-prompt";
import { latestCompactEntry } from "./compact";

export interface ContextCategory {
    key:
        | "systemPrompt"
        | "systemTools"
        | "mcpTools"
        | "workspaceContext"
        | "memory"
        | "skills"
        | "messages"
        | "compactSummary";
    label: string;
    tokens: number;
}

export interface SkillTokenEstimate {
    name: string;
    tokens: number;
}

export interface ContextReport {
    modelId: string;
    contextWindow: number;
    autoCompactThreshold: number;
    categories: ContextCategory[];
    /** Sum of all categories (estimated used tokens). */
    totalTokens: number;
    freeTokens: number;
    skills: SkillTokenEstimate[];
    toolCount: number;
    mcpToolCount: number;
}

const chars4 = (n: number) => Math.ceil(n / 4);

/** Same shape as estimateOverheadTokens: name + description at chars/4 plus a
 * flat allowance per tool for the JSON schema body. */
const TOOL_SCHEMA_ALLOWANCE_TOKENS = 120;

function toolTokens(tools: Record<string, unknown>): number {
    let chars = 0;
    let count = 0;
    for (const [name, tool] of Object.entries(tools)) {
        chars += name.length + ((tool as { description?: string })?.description?.length ?? 0);
        count++;
    }
    return chars4(chars) + count * TOOL_SCHEMA_ALLOWANCE_TOKENS;
}

/** The task tool is assembled per-turn with live wiring, so it can't be built
 * here — count its prompt surface (description + schema) as a flat estimate. */
const TASK_TOOL_EST_TOKENS = 400;

export async function buildContextReport(opts: {
    session: Session | null;
    modelId: string;
    cwd: string;
    agent?: string;
}): Promise<ContextReport> {
    const { session, modelId, cwd } = opts;
    const catalog = await getCatalog();
    const contextWindow = catalog[modelId]?.contextWindow ?? 0;
    const autoCompactThreshold = getSetting("autoCompactThreshold") ?? 0.8;

    const workspace = getSetting("workspaceContext") !== false ? loadWorkspaceContext(cwd) : { text: "", files: [] };
    const memoryText = getSetting("memory") !== false ? loadMemoryContext(cwd).text : "";
    const skillsEnabled = getSetting("skills") !== false && isTrusted(cwd);
    const skills = skillsEnabled ? await loadProjectSkills(cwd) : { skills: [], diagnostics: [], promptBlock: "" };

    const agentPrompt = opts.agent ? getAgentPrompt(opts.agent) : undefined;
    const allowedTools = opts.agent ? getAgentTools(opts.agent) : undefined;

    // Builtin + extension tools (what runTurn calls "system tools").
    const fullToolSet = createTools({ cwd, sessionId: session?.id ?? "context-report" });
    const toolSet: Record<string, unknown> = allowedTools?.length
        ? Object.fromEntries(Object.entries(fullToolSet).filter(([name]) => allowedTools.includes(name)))
        : { ...fullToolSet };
    if (!allowedTools?.length && isTrusted(cwd)) {
        const ext = getExtensionHost().getTools();
        for (const [name, tool] of ext.add) toolSet[name] = tool;
        for (const name of ext.remove) delete toolSet[name];
    }

    const mcpTools = isMcpEnabled() && isTrusted(cwd) && !allowedTools?.length ? getMcpManager().getTools() : {};
    const mcpToolCount = Object.keys(mcpTools).length;

    const subagentsEnabled =
        getSetting("subagents") !== false && (!allowedTools?.length || allowedTools.includes("task"));
    const subagentNote = subagentsEnabled ? buildSubagentNote(listAgents().map((a) => a.name)) : "";

    // System prompt measured WITHOUT workspace context / skills — those are
    // separate categories below.
    const toolNames = [...Object.keys(toolSet), ...Object.keys(mcpTools), ...(subagentsEnabled ? ["task"] : [])];
    const systemBase = buildSystemPrompt({ cwd, basePrompt: agentPrompt, tools: toolNames }) + subagentNote;

    let systemToolTokens = toolTokens(toolSet);
    if (subagentsEnabled) systemToolTokens += TASK_TOOL_EST_TOKENS;

    // Transcript walk — same branch/compaction rules as estimateContextTokens,
    // split into the compact summary vs live messages.
    let messageChars = 0;
    let compactTokens = 0;
    if (session) {
        const compact = latestCompactEntry(session);
        if (compact) compactTokens = chars4(compact.summary.length + 200);
        let messageIndex = 0;
        for (const e of session.getBranch()) {
            if (e.type === "message") {
                const idx = messageIndex++;
                if (compact && idx < compact.cutAt) continue;
            } else if (e.type === "subagent" || e.type === "branch-summary") {
                if (compact && messageIndex < compact.cutAt) continue;
            } else {
                continue;
            }
            messageChars += JSON.stringify(e).length;
        }
    }

    const categories: ContextCategory[] = [
        { key: "systemPrompt", label: "System prompt", tokens: chars4(systemBase.length) },
        { key: "systemTools", label: "System tools", tokens: systemToolTokens },
        ...(mcpToolCount > 0
            ? [{ key: "mcpTools", label: "MCP tools", tokens: toolTokens(mcpTools) } as ContextCategory]
            : []),
        ...(workspace.text
            ? [
                  {
                      key: "workspaceContext",
                      label: "Workspace context",
                      tokens: chars4(workspace.text.length),
                  } as ContextCategory,
              ]
            : []),
        ...(memoryText
            ? [{ key: "memory", label: "Memory", tokens: chars4(memoryText.length) } as ContextCategory]
            : []),
        ...(skills.promptBlock
            ? [{ key: "skills", label: "Skills", tokens: chars4(skills.promptBlock.length) } as ContextCategory]
            : []),
        { key: "messages", label: "Messages", tokens: chars4(messageChars) },
        ...(compactTokens > 0
            ? [{ key: "compactSummary", label: "Compact summary", tokens: compactTokens } as ContextCategory]
            : []),
    ];

    const totalTokens = categories.reduce((sum, c) => sum + c.tokens, 0);
    // Per-skill estimate: each skill's <skill> entry in the prompt block is its
    // escaped name + description plus the XML wrapper.
    const skillEstimates: SkillTokenEstimate[] = skills.skills
        .filter((s) => !s.disableModelInvocation)
        .map((s) => ({ name: s.name, tokens: chars4(s.name.length + s.description.length + 40) }))
        .sort((a, b) => b.tokens - a.tokens);

    return {
        modelId,
        contextWindow,
        autoCompactThreshold,
        categories,
        totalTokens,
        freeTokens: Math.max(0, contextWindow - totalTokens),
        skills: skillEstimates,
        toolCount: Object.keys(toolSet).length + (subagentsEnabled ? 1 : 0),
        mcpToolCount,
    };
}
