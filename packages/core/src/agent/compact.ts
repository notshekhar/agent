import { generateText } from "ai";
import { getModel } from "../providers";
import { attachLedgerEntry, type Session } from "../sessions";
import { formatTodoList, hasActiveTodos, isTodosPayload, type TodoItem } from "../tools/todo";
import { isAbortError } from "./abort";
import { BRANCH_SUMMARY_PREAMBLE } from "./branch-summary";
import { stampUsageCost, type CostTracker } from "./cost";
import type { UsageBlock } from "../types";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/**
 * Opens a rollover's replacement block. A rollover starts a fresh window with
 * no summary at all, so the model is told three things it cannot infer: the
 * earlier conversation is recoverable rather than lost, the record below is
 * inputs and not progress, and live state must be re-checked before acting on
 * it. Kept next to the summary constants because both are read by
 * compactedContextEntries and measured by estimateContextTokens.
 */
export const ROLLOVER_PREAMBLE = `A fresh context window starts here. The conversation before this point left your active context WITHOUT a summary. It is intact in this session and recoverable with the history tool.

What follows is a recovery record of inputs and state — NOT a record of progress. The previous window may already have finished some or all of its work. Restore the todo list, read the notes it names, and verify live state before continuing any stateful or external work.

<handoff>`;
export const ROLLOVER_SUFFIX = `
</handoff>`;

/** The replacement block a compaction or rollover puts at the head of the window. */
export function compactionBlockText(entry: { summary: string; handoff?: string }): string {
    return entry.handoff
        ? `${ROLLOVER_PREAMBLE}\n${entry.handoff}${ROLLOVER_SUFFIX}`
        : `${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTION_SUMMARY_SUFFIX}`;
}

/** Body text for display surfaces — the handoff on a rollover, else the summary. */
export function compactionBodyText(entry: { summary: string; handoff?: string }): string {
    return entry.handoff ?? entry.summary;
}

const COMPACT_PROMPT = `You are summarizing a developer's coding session. Produce a dense factual summary that preserves:
- User intent across the segment.
- Files touched (paths + nature of edits).
- Important tool outputs (errors, build results, test runs).
- Open questions and unresolved threads.

Do NOT add commentary. Use short bullet style.`;

export interface CompactResult {
    summary: string;
    cutAt: number;
    tokensBefore: number;
    tokensAfter: number;
}

function estimateTokens(text: string): number {
    // crude 4 chars/token
    return Math.ceil(text.length / 4);
}

export function latestCompactEntry(session: Session) {
    return latestCompact(session);
}

function latestCompact(session: Session) {
    // Path-based: a compaction on an abandoned branch must not apply after
    // /tree navigation moved the leaf elsewhere.
    let latest:
        | { summary: string; cutAt: number; ts: number; tokensBefore: number; tokensAfter: number; handoff?: string; rollover?: true }
        | undefined;
    for (const entry of session.getBranch()) {
        if (entry.type === "compact") latest = entry;
    }
    return latest;
}

function messageToText(message: { role: "user" | "assistant" | "tool"; content: unknown }): string {
    return `[${message.role}] ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`;
}

export function compactedContextMessages(
    session: Session,
): Array<{ role: "user" | "assistant" | "tool"; content: unknown }> {
    const messages = session.messages();
    const compact = latestCompact(session);
    if (!compact) return messages;

    return [{ role: "user", content: compactionBlockText(compact) }, ...messages.slice(compact.cutAt)];
}

export type ContextEntry =
    | { kind: "message"; role: "user" | "assistant" | "tool"; content: unknown; interrupted?: boolean }
    | { kind: "subagent"; agent: string; result: string };

/**
 * Like compactedContextMessages, but keeps subagent entries interleaved in
 * chronological order so resumed sessions retain subagent reports in the
 * model context. The compact cutAt counts only message entries — subagent
 * entries ride along with the messages that survive the cut.
 *
 * Walks the current branch path (leaf → root), not the whole file, so
 * abandoned branches stay out of the context after /tree navigation.
 * Branch-summary entries on the path join the context as user messages.
 */
export function compactedContextEntries(session: Session): ContextEntry[] {
    const compact = latestCompact(session);
    const out: ContextEntry[] = [];
    let messageIndex = 0;
    // Todo survival: a checklist whose last write fell into the summarized
    // region would otherwise vanish from the model's context (the panel keeps
    // showing it, but the model no longer knows it exists). Track the latest
    // pre-cut list; a post-cut write supersedes it (its tool call/result
    // survives in the kept messages, so no re-injection needed).
    let preCutTodos: TodoItem[] | null = null;
    for (const e of session.getBranch()) {
        if (e.type === "message") {
            const idx = messageIndex++;
            if (compact && idx < compact.cutAt) continue;
            out.push({ kind: "message", role: e.role, content: e.content, interrupted: e.interrupted });
        } else if (e.type === "subagent") {
            if (compact && messageIndex < compact.cutAt) continue;
            out.push({ kind: "subagent", agent: e.agent, result: e.result });
        } else if (e.type === "branch-summary" && e.summary) {
            if (compact && messageIndex < compact.cutAt) continue;
            out.push({ kind: "message", role: "user", content: `${BRANCH_SUMMARY_PREAMBLE}${e.summary}` });
        } else if (e.type === "custom" && compact && isTodosPayload(e.payload)) {
            preCutTodos = messageIndex < compact.cutAt ? e.payload.items : null;
        }
    }
    if (compact) {
        if (preCutTodos && hasActiveTodos(preCutTodos)) {
            // Load-bearing under a rollover: with no summary to carry state, the
            // checklist is the main thing that survives the boundary.
            const where = compact.handoff ? "the context rollover above" : "the compaction above";
            out.unshift({
                kind: "message",
                role: "user",
                content:
                    `Your todo checklist was active before ${where}. Current list:\n` +
                    `${formatTodoList(preCutTodos)}\n` +
                    "Keep maintaining it with the todo tool — resend the full list, updated, as you make progress.",
            });
        }
        out.unshift({ kind: "message", role: "user", content: compactionBlockText(compact) });
    }
    return out;
}

export class CompactAbortedError extends Error {
    constructor() {
        super("compact aborted");
        this.name = "CompactAbortedError";
    }
}

/**
 * Where the kept window starts. Purely numeric cuts can land on a tool
 * result whose tool-call just got summarized away — Anthropic 400s on the
 * orphaned tool_result — so walk back over tool messages to the assistant
 * message that carries the matching tool calls.
 */
export function compactCut(messages: ReadonlyArray<{ role: string }>, previousCut: number, keep: number): number {
    let cut = Math.max(previousCut, messages.length - keep);
    while (cut > previousCut && messages[cut]?.role === "tool") cut--;
    return cut;
}

export async function runCompact(opts: {
    session: Session;
    modelId: string;
    keepTurns?: number;
    abortSignal?: AbortSignal;
    /** Bills the summarization call (source "compact") — real API spend that
     * historically went unrecorded. */
    tracker?: CostTracker;
    cwd?: string;
}): Promise<CompactResult> {
    const keep = opts.keepTurns ?? 4;
    const messages = opts.session.messages();
    const previousCompact = latestCompact(opts.session);
    const previousCut = previousCompact?.cutAt ?? 0;
    const cut = compactCut(messages, previousCut, keep);
    if (cut <= previousCut) {
        return { summary: "", cutAt: 0, tokensBefore: 0, tokensAfter: 0 };
    }

    if (opts.abortSignal?.aborted) throw new CompactAbortedError();

    const head = messages.slice(previousCut, cut);
    const previousSummary = previousCompact
        ? `${COMPACTION_SUMMARY_PREFIX}${previousCompact.summary}${COMPACTION_SUMMARY_SUFFIX}\n`
        : "";
    const headText = previousSummary + head.map(messageToText).join("\n");
    const fullContextText = previousSummary + messages.slice(previousCut).map(messageToText).join("\n");
    const tokensBefore = estimateTokens(fullContextText);

    const model = await getModel(opts.modelId);
    let text: string;
    let usage: UsageBlock | undefined;
    try {
        const result = await generateText({
            model,
            instructions: COMPACT_PROMPT,
            prompt: headText,
            abortSignal: opts.abortSignal,
        });
        text = result.text;
        usage = result.usage;
    } catch (err) {
        if (isAbortError(err) || opts.abortSignal?.aborted) throw new CompactAbortedError();
        throw err;
    }

    if (opts.abortSignal?.aborted) throw new CompactAbortedError();

    if (opts.tracker && usage) {
        opts.tracker.add(opts.modelId, usage, {
            cwd: opts.cwd ?? opts.session.info.cwd,
            sessionPub: opts.session.info.id,
            source: "compact",
        });
    }
    const tokensAfter = estimateTokens(text);
    const entry = {
        type: "compact" as const,
        ts: Date.now(),
        summary: text,
        cutAt: cut,
        tokensBefore,
        tokensAfter,
        ...(usage ? { usage: stampUsageCost(opts.modelId, usage), model: opts.modelId } : {}),
    };
    await opts.session.append(entry);
    const rowId = opts.tracker?.takeLastLedgerRowId();
    const entryId = (entry as { id?: string }).id;
    if (rowId !== undefined && entryId) attachLedgerEntry(rowId, entryId);
    return { summary: text, cutAt: cut, tokensBefore, tokensAfter };
}
