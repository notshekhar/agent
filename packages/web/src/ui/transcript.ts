/** Transcript rendering: blocks, tool/reasoning/subagent cards, and history
 * entry replay. Owns all DOM inside #blocks. */
import { byId } from "../lib/dom";
import { escapeHtml, pretty, renderMarkdown, toolOutputText, truncate } from "../lib/format";
import { clear as clearAttachments } from "../features/attachments-instance";
import { state } from "../state";

export const blocks = byId("blocks");

export interface ToolCard {
    det: HTMLDetailsElement;
    name: Element;
    sum: Element;
    input: HTMLElement | null;
    output: HTMLElement | null;
    outLabel: HTMLElement | null;
    inputRaw: string;
    mode: "generic" | "term" | "diff";
    start: number;
}

interface SubagentCard {
    det: HTMLDetailsElement;
    name: Element;
    sum: Element;
    body: HTMLElement;
    textEl: HTMLElement | null;
}

export const toolCards = new Map<string, ToolCard>();
const subagentCards = new Map<string, SubagentCard>();

let liveText: { el: HTMLElement; raw: string } | null = null;
let liveReasoning: { det: HTMLDetailsElement; pre: HTMLElement; raw: string } | null = null;

export function clearTranscript(): void {
    blocks.innerHTML = "";
    liveText = null;
    liveReasoning = null;
    toolCards.clear();
    subagentCards.clear();
    clearAttachments();
    byId("todos").classList.remove("visible");
    byId("cost").textContent = "";
    byId("ctx").textContent = "";
    byId("scrollDown").classList.remove("visible");
}

export function scrollDown(): void {
    const t = byId("transcript");
    if (t.scrollHeight - t.scrollTop - t.clientHeight < 160) t.scrollTop = t.scrollHeight;
}

export function addBlock(cls: string, html: string): HTMLElement {
    const div = document.createElement("div");
    div.className = "block " + cls;
    div.innerHTML = html;
    blocks.appendChild(div);
    scrollDown();
    return div;
}
export function addUser(text: string): void {
    addBlock("user", escapeHtml(text));
}
export function addNote(text: string): void {
    addBlock("note", escapeHtml(text));
}
export function addError(text: string): void {
    addBlock("error", escapeHtml(truncate(text)));
}

export function assistantText(): { el: HTMLElement; raw: string } {
    if (!liveText) {
        const div = addBlock("assistant", '<div class="md"></div><button class="copy-btn">copy</button>');
        liveText = { el: div.querySelector<HTMLElement>(".md")!, raw: "" };
    }
    return liveText;
}

/* Streaming deltas arrive far faster than frames. Re-rendering markdown and
 * forcing layout per delta makes the whole page (typing included) janky, so
 * appends accumulate and paint at most once per animation frame. Each box
 * schedules its own flush, so text broken mid-frame still renders fully. */
let pendingText: { el: HTMLElement; raw: string } | null = null;
export function appendAssistantText(delta: string): void {
    const t = assistantText();
    t.raw += delta;
    if (pendingText !== t) {
        pendingText = t;
        requestAnimationFrame(() => {
            if (pendingText === t) pendingText = null;
            t.el.innerHTML = renderMarkdown(t.raw);
            scrollDown();
        });
    }
}

let pendingReasoning: { pre: HTMLElement; raw: string } | null = null;
export function appendReasoning(delta: string): void {
    const r = reasoningBox();
    r.raw += delta;
    if (pendingReasoning !== r) {
        pendingReasoning = r;
        requestAnimationFrame(() => {
            if (pendingReasoning === r) pendingReasoning = null;
            r.pre.textContent = truncate(r.raw);
            scrollDown();
        });
    }
}

function rowEl(cls: string, name: string, summary: string): HTMLDetailsElement {
    const det = document.createElement("details");
    det.className = "row " + cls;
    det.innerHTML =
        '<summary><span class="chev">&#x203A;</span><span class="tname"></span><span class="tsum"></span></summary>' +
        '<div class="body"></div>';
    det.querySelector(".tname")!.textContent = name;
    det.querySelector(".tsum")!.textContent = summary || "";
    blocks.appendChild(det);
    scrollDown();
    return det;
}

export function reasoningBox(): { det: HTMLDetailsElement; pre: HTMLElement; raw: string } {
    if (!liveReasoning) {
        const det = rowEl("reasoning", "thinking", "");
        const body = det.querySelector<HTMLElement>(".body")!;
        const pre = document.createElement("pre");
        body.appendChild(pre);
        liveReasoning = { det, pre, raw: "" };
    }
    return liveReasoning;
}
export function breakLiveText(): void {
    liveText = null;
}
export function breakReasoning(): void {
    if (liveReasoning) liveReasoning.det.querySelector(".tname")!.textContent = "thought";
    liveReasoning = null;
}

/* One-line summary for a tool call, like the TUI's tool boxes. */
export function toolSummary(name: string | undefined, input: any): string {
    if (!input || typeof input !== "object") return "";
    const i = input;
    if (typeof i.command === "string") return i.command;
    if (typeof i.file_path === "string") return shortPath(i.file_path);
    if (typeof i.path === "string") return shortPath(i.path);
    if (typeof i.pattern === "string") return i.pattern;
    if (typeof i.url === "string") return i.url;
    if (typeof i.query === "string") return i.query;
    const j = pretty(i);
    return j.length > 80 ? j.slice(0, 80) + "…" : j;
}

function shortPath(p: unknown): string {
    // Paths inside the session cwd render relative — the interesting part.
    const cwd = state.current && state.current.cwd;
    if (cwd && String(p).startsWith(cwd + "/")) return String(p).slice(cwd.length + 1);
    return String(p);
}

function diffHtml(file: string | undefined, oldStr: unknown, newStr: unknown): string {
    const MAXL = 120;
    const lines = (s: unknown, cls: string) =>
        String(s ?? "")
            .split("\n")
            .slice(0, MAXL)
            .map((l) => '<div class="dl ' + cls + '">' + escapeHtml(l) + "</div>")
            .join("");
    return (
        '<div class="diff">' +
        (file ? '<div class="dfile">' + escapeHtml(shortPath(file)) + "</div>" : "") +
        lines(oldStr, "del") +
        lines(newStr, "add") +
        "</div>"
    );
}

/* Structured body per tool — bash gets a terminal block, edit a diff,
 * write a file preview; everything else keeps the generic input pre. */
export function renderToolInput(card: ToolCard, name: string | undefined, input: any): void {
    const body = card.det.querySelector<HTMLElement>(".body")!;
    if (name === "bash" && input && typeof input.command === "string") {
        body.innerHTML =
            '<div class="term"><div class="cmd">' +
            escapeHtml(truncate(input.command)) +
            '</div><div class="out" style="display:none"></div></div>';
        card.output = body.querySelector<HTMLElement>(".out");
        card.mode = "term";
    } else if (name === "edit" && input && typeof input.old_string === "string") {
        body.innerHTML =
            diffHtml(input.file_path, input.old_string, input.new_string) +
            '<pre class="output" style="display:none"></pre>';
        card.output = body.querySelector<HTMLElement>(".output");
        card.mode = "diff";
    } else if (name === "write" && input && typeof input.content === "string") {
        body.innerHTML =
            diffHtml(input.file_path, "", input.content) + '<pre class="output" style="display:none"></pre>';
        card.output = body.querySelector<HTMLElement>(".output");
        card.mode = "diff";
    } else {
        body.innerHTML =
            '<div class="label">input</div><pre class="input"></pre>' +
            '<div class="label out-label" style="display:none">result</div><pre class="output" style="display:none"></pre>';
        card.input = body.querySelector<HTMLElement>(".input");
        card.output = body.querySelector<HTMLElement>(".output");
        card.outLabel = body.querySelector<HTMLElement>(".out-label");
        card.input!.textContent = truncate(pretty(input));
        card.mode = "generic";
    }
}

export function toolCard(id: string, name?: string): ToolCard {
    let card = toolCards.get(id);
    if (!card) {
        const det = rowEl("tool running", name || "tool", "");
        const body = det.querySelector<HTMLElement>(".body")!;
        body.innerHTML =
            '<div class="label">input</div><pre class="input"></pre>' +
            '<div class="label out-label" style="display:none">result</div><pre class="output" style="display:none"></pre>';
        card = {
            det,
            name: det.querySelector(".tname")!,
            sum: det.querySelector(".tsum")!,
            input: body.querySelector<HTMLElement>(".input"),
            output: body.querySelector<HTMLElement>(".output"),
            outLabel: body.querySelector<HTMLElement>(".out-label"),
            inputRaw: "",
            mode: "generic",
            start: Date.now(),
        };
        toolCards.set(id, card);
    }
    if (name) card.name.textContent = name;
    return card;
}

export function finishToolCard(card: ToolCard, output: unknown, isError: boolean): void {
    card.det.classList.remove("running");
    if (isError) card.det.classList.add("error");
    // Elapsed badge on the summary — only meaningful live (history has no timing).
    if (card.start && !card.det.dataset.replay) {
        const ms = Date.now() - card.start;
        card.sum.textContent =
            (card.sum.textContent || "") + "  · " + (ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s");
    }
    if (output !== undefined && card.output) {
        card.output.textContent = truncate(toolOutputText(output));
        card.output.style.display = "";
        if (card.outLabel) card.outLabel.style.display = "";
    }
    scrollDown();
}

export function subagentCard(id: string, agent: string): SubagentCard {
    let card = subagentCards.get(id);
    if (!card) {
        const det = rowEl("subagent running", "task", agent);
        det.open = true;
        card = {
            det,
            name: det.querySelector(".tname")!,
            sum: det.querySelector(".tsum")!,
            body: det.querySelector<HTMLElement>(".body")!,
            textEl: null,
        };
        subagentCards.set(id, card);
    }
    card.sum.textContent = agent;
    return card;
}

export function getSubagentCard(id: string): SubagentCard | undefined {
    return subagentCards.get(id);
}

/* ---------- history replay ---------- */

export function renderEntry(entry: any): void {
    if (entry.type === "message") {
        const content = entry.content;
        if (entry.role === "user") {
            addUser(extractText(content) || "(attachment)");
        } else if (entry.role === "assistant") {
            const parts = Array.isArray(content) ? content : [{ type: "text", text: extractText(content) }];
            for (const p of parts) {
                if (p.type === "text" && p.text) {
                    addBlock(
                        "assistant",
                        '<div class="md">' + renderMarkdown(p.text) + '</div><button class="copy-btn">copy</button>',
                    );
                } else if (p.type === "reasoning" && p.text) {
                    const det = rowEl("reasoning", "thought", "");
                    const pre = document.createElement("pre");
                    pre.textContent = truncate(p.text);
                    det.querySelector(".body")!.appendChild(pre);
                } else if (p.type === "tool-call") {
                    const card = toolCard(p.toolCallId || String(Math.random()), p.toolName || "tool");
                    card.det.dataset.replay = "1";
                    renderToolInput(card, p.toolName, p.input ?? p.args);
                    card.sum.textContent = toolSummary(p.toolName, p.input ?? p.args);
                    card.det.classList.remove("running");
                }
            }
            if (entry.interrupted) addNote("interrupted");
        } else if (entry.role === "tool") {
            const parts = Array.isArray(content) ? content : [];
            for (const p of parts) {
                if (p.type !== "tool-result") continue;
                const card = toolCards.get(p.toolCallId);
                if (card) finishToolCard(card, p.output ?? p.result, false);
            }
        }
    } else if (entry.type === "subagent") {
        const card = subagentCard(entry.toolCallId || String(Math.random()), entry.agent);
        card.det.open = false;
        card.det.classList.remove("running");
        card.body.innerHTML =
            '<div class="label">prompt</div><pre>' +
            escapeHtml(truncate(entry.prompt)) +
            "</pre>" +
            '<div class="label">result</div><pre>' +
            escapeHtml(truncate(entry.result)) +
            "</pre>";
    } else if (entry.type === "compact") {
        addNote(
            "compacted: " +
                Math.round(entry.tokensBefore / 1000) +
                "k to " +
                Math.round(entry.tokensAfter / 1000) +
                "k tokens",
        );
    } else if (entry.type === "branch-summary") {
        addNote("branched; abandoned path summarized");
    } else if (entry.type === "model-change") {
        addNote("model: " + entry.from + " to " + entry.to);
    }
}

function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p && p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("\n");
    }
    return "";
}
