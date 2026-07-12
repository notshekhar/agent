import {
    isRecapPayload,
    latestTodos,
    parseModelId,
    seedSessionTodos,
    type Entry,
    type Session,
} from "@notshekhar/loop-core";
import type { ChatHistory } from "./components/chat-history";
import type { TodoPanel } from "./components/todo-panel";

/** AI-SDK content part shapes we replay from persisted assistant/tool messages. */
interface ReplayPart {
    type?: string;
    text?: string;
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
    output?: { type?: string; value?: unknown };
}

/**
 * Render the session's current branch path (root → leaf) into the chat.
 * Shared by /resume, /fork, and /tree navigation so all three replay the
 * same way. Path-based: abandoned branches don't render.
 */
export function renderSessionBranch(
    session: Session,
    history: ChatHistory,
    modelId: string,
    todoPanel?: TodoPanel,
): void {
    const path = session.getBranch();
    // Branch navigation restores the branch's own latest checklist (or clears
    // the panel on a branch that never had one). The core map seeds alongside
    // the panel so the staleness nudger and RPC readers agree with the screen —
    // after a process restart the map would otherwise be empty.
    const todos = latestTodos(path) ?? [];
    todoPanel?.setItems(todos);
    seedSessionTodos(session.id, todos);

    let latestCompact: Extract<Entry, { type: "compact" }> | undefined;
    for (const e of path) {
        if (e.type === "compact") latestCompact = e;
    }
    if (latestCompact) {
        history.addCompactionSummary(latestCompact.summary, latestCompact.tokensBefore, latestCompact.ts);
    }

    const { provider } = parseModelId(modelId);
    let messageIndex = 0;
    // Subagent entries persist when the run FINISHES — before the step's own
    // assistant message (which persists at step end). Live, the task boxes
    // appear after the text that streamed before them. Buffer them and flush
    // after the next assistant message so replay matches the live order.
    const pendingSubagents: Array<Extract<Entry, { type: "subagent" }>> = [];
    const flushSubagents = (): void => {
        for (const e of pendingSubagents) {
            const id = `replay-task-${e.ts}`;
            history.addToolCall("task", id, { agent: e.agent, prompt: e.prompt });
            const stats =
                e.steps !== undefined || e.durationMs !== undefined || e.usage?.usd !== undefined
                    ? { steps: e.steps, durationMs: e.durationMs, usd: e.usage?.usd }
                    : undefined;
            history.addToolResult(
                id,
                e.activity || stats ? { history: e.activity ?? [], report: e.result, stats } : e.result,
            );
        }
        pendingSubagents.length = 0;
    };
    for (const e of path) {
        if (e.type === "message") {
            const currentMessageIndex = messageIndex++;
            if (latestCompact && currentMessageIndex < latestCompact.cutAt) continue;
            if (e.role === "user") {
                flushSubagents(); // turn boundary — anything left renders first
                history.addUser(String(e.content ?? ""), e.ts);
            } else if (e.role === "assistant") {
                history.ensureAssistant(provider, modelId, e.ts);
                // Persisted per-reasoning-part durations, in part order — so
                // "Thought for Xs" survives resume.
                const reasoningMs = [...((e as { reasoningMs?: number[] }).reasoningMs ?? [])];
                // Structured content (text + tool-call parts) replays the tool
                // boxes; legacy string content is plain assistant text.
                if (Array.isArray(e.content)) {
                    for (const part of e.content as ReplayPart[]) {
                        if (part.type === "text" && part.text) {
                            history.appendAssistantDelta(part.text, provider, modelId);
                        } else if (part.type === "reasoning" && part.text) {
                            history.appendAssistantThinking(part.text, provider, modelId, reasoningMs.shift());
                        } else if (part.type === "tool-call" && part.toolCallId) {
                            history.addToolCall(
                                part.toolName ?? "tool",
                                part.toolCallId,
                                (part.input ?? {}) as Record<string, unknown>,
                            );
                        }
                    }
                } else {
                    history.appendAssistantDelta(String(e.content ?? ""), provider, modelId);
                }
                history.finishAssistant();
                flushSubagents(); // this step's task boxes follow its text
            } else if (e.role === "tool") {
                // Tool results: resolve the matching tool box created above.
                if (Array.isArray(e.content)) {
                    for (const part of e.content as ReplayPart[]) {
                        if (part.type === "tool-result" && part.toolCallId) {
                            const isError = part.output?.type === "error-text" || part.output?.type === "error-json";
                            history.addToolResult(part.toolCallId, part.output ?? "", isError);
                        }
                    }
                }
            }
        } else if (e.type === "subagent") {
            if (latestCompact && messageIndex < latestCompact.cutAt) continue;
            pendingSubagents.push(e);
        } else if (e.type === "branch-summary" && e.summary) {
            if (latestCompact && messageIndex < latestCompact.cutAt) continue;
            history.addBranchSummary(e.summary);
        } else if (e.type === "custom" && isRecapPayload(e.payload)) {
            if (latestCompact && messageIndex < latestCompact.cutAt) continue;
            history.addRecap(e.payload.text);
        }
    }
    flushSubagents();
}
