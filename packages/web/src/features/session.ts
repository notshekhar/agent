/** Session lifecycle: open, draft, send (with the type-ahead prompt queue),
 * cancel, and per-session cost. */
import { byId } from "../lib/dom";
import { rpc } from "../services/connection";
import { state } from "../state";
import { setRoute } from "../ui/router";
import { setRunning, setStatus } from "../ui/status";
import {
    addError,
    addUser,
    blocks,
    breakLiveText,
    breakReasoning,
    clearTranscript,
    renderEntry,
    scrollDown,
} from "../ui/transcript";
import { renderCrumb, showChat, showHome } from "../ui/views";
import { attachments, clear as clearAttachments } from "./attachments-instance";
import { initModel } from "./model-picker";

export async function openSession(id: string): Promise<void> {
    setRunning(false);
    resetTranscript();
    try {
        const opened = await rpc("session.open", { sessionId: id });
        const hist = await rpc("session.history", { sessionId: id });
        state.current = {
            id,
            model: opened.info.model,
            name: hist.name || null,
            cwd: opened.info.cwd,
            draft: false,
        };
        for (const entry of hist.entries || []) renderEntry(entry);
        breakLiveText();
        initModel(opened.info.model);
        setRoute(id);
        showChat();
        // Subscribe from the history snapshot's seq: events that fired between
        // history and here replay in order, none dropped, none doubled. A turn
        // already running (started by another tab) streams in live.
        state.lastSeq = hist.seq || 0;
        const att = await rpc("session.attach", { sessionId: id, afterSeq: state.lastSeq });
        setRunning(att.running);
        if (att.running) setStatus("working…");
        refreshCost();
        byId("transcript").scrollTop = byId("transcript").scrollHeight;
    } catch (err: any) {
        setStatus("open failed: " + err.message);
        setRoute(null);
        showHome();
    }
}

/* opencode flow: "New session" opens an empty chat; the session is created
 * on the first prompt so abandoned drafts never hit the DB. */
export function newDraft(cwd: string): void {
    setRoute(null);
    state.lastSeq = 0;
    setRunning(false);
    resetTranscript();
    state.current = { id: null, model: state.selectedModel, name: null, cwd, draft: true };
    initModel(state.selectedModel);
    showChat();
}

function resetTranscript(): void {
    clearTranscript();
    promptQueue.length = 0; // queued cards live in #blocks, already wiped by clearTranscript
}

async function ensureSession(): Promise<void> {
    const current = state.current!;
    if (!current.draft) return;
    const model = state.selectedModel;
    const provider = (state.catalog.find((m) => m.id === model) || {}).provider || model.split("/")[0];
    const r = await rpc("session.create", { cwd: current.cwd, model, provider });
    current.id = r.sessionId;
    current.draft = false;
    setRoute(current.id);
}

/* Messages typed while a turn runs queue up (dashed cards) and auto-send
 * as turns finish — same flow as typing ahead in the TUI. */
interface QueuedPrompt {
    input: string;
    images: Array<{ data: string; mediaType: string }>;
    label: string;
    el: HTMLElement;
}
const promptQueue: QueuedPrompt[] = [];

export function sendPrompt(): void {
    const inputEl = byId<HTMLTextAreaElement>("input");
    const input = inputEl.value.trim();
    if ((!input && !attachments.length) || !state.current) return;
    const images = attachments.map((a) => ({ data: a.data, mediaType: a.mediaType }));
    const label =
        input +
        (attachments.length
            ? "\n(" + attachments.length + " image" + (attachments.length > 1 ? "s" : "") + " attached)"
            : "");
    clearAttachments();
    inputEl.value = "";
    inputEl.style.height = "auto";
    if (state.running) {
        enqueuePrompt(input, images, label);
        return;
    }
    void doSend(input, images, label);
}

function enqueuePrompt(input: string, images: QueuedPrompt["images"], label: string): void {
    const div = document.createElement("div");
    div.className = "block user queued";
    div.innerHTML = '<button class="qremove" title="remove from queue">x</button><span class="qtag">queued</span>';
    div.appendChild(document.createTextNode(label));
    const item: QueuedPrompt = { input, images, label, el: div };
    div.querySelector<HTMLButtonElement>(".qremove")!.onclick = () => {
        const idx = promptQueue.indexOf(item);
        if (idx >= 0) promptQueue.splice(idx, 1);
        div.remove();
    };
    blocks.appendChild(div);
    promptQueue.push(item);
    setStatus("working… (" + promptQueue.length + " queued)");
    scrollDown();
}

export function drainQueue(): void {
    if (state.running || !promptQueue.length || !state.current) return;
    const item = promptQueue.shift()!;
    item.el.remove();
    void doSend(item.input, item.images, item.label);
}

async function doSend(input: string, images: QueuedPrompt["images"], label: string): Promise<void> {
    addUser(label);
    breakLiveText();
    breakReasoning();
    setRunning(true);
    setStatus("working…");
    try {
        await ensureSession();
        renderCrumb();
        await rpc("session.send", {
            sessionId: state.current!.id,
            input,
            model: state.selectedModel || state.current!.model,
            images: images.length ? images : undefined,
            thinking: byId<HTMLSelectElement>("thinkSel").value || undefined,
        });
    } catch (err: any) {
        setRunning(false);
        addError("send failed: " + err.message);
        drainQueue();
    }
}

export async function cancelTurn(): Promise<void> {
    if (!state.current || !state.current.id) return;
    // Unlock the composer immediately — the server abort is async and the AI
    // SDK may not emit stream `finish` until the in-flight chunk drains.
    setRunning(false);
    setStatus("");
    breakLiveText();
    breakReasoning();
    try {
        await rpc("session.cancel", { sessionId: state.current.id });
    } catch {}
}

export async function refreshCost(): Promise<void> {
    if (!state.current || !state.current.id) return;
    try {
        const c = await rpc("cost.session", { sessionId: state.current.id });
        if (c && typeof c.usd === "number" && c.usd > 0) {
            byId("cost").textContent = (c.estimated ? "~" : "") + "$" + c.usd.toFixed(4);
        }
    } catch {}
}
