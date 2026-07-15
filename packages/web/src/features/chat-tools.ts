/** The strip under the composer: expand/collapse tools, compact, plus
 * transcript scroll affordances and copy buttons. */
import { byId } from "../lib/dom";
import { rpc } from "../services/connection";
import { state } from "../state";
import { setRunning, setStatus } from "../ui/status";
import { addError, addNote, blocks } from "../ui/transcript";
import { drainQueue, openSession } from "./session";

export function wireChatTools(): void {
    /* Compact: server-side summarize, then re-render from the new history.
     * The wait is a real model call — make it unmissable: pulsing yellow
     * button, a note in the transcript, and the composer in its busy state. */
    byId<HTMLButtonElement>("compactBtn").onclick = async () => {
        if (!state.current || !state.current.id || state.running) return;
        const btn = byId<HTMLButtonElement>("compactBtn");
        btn.disabled = true;
        btn.classList.add("busy");
        btn.textContent = "compacting…";
        addNote("compacting — summarizing older turns (takes a few seconds)…");
        setRunning(true);
        setStatus("compacting…");
        try {
            await rpc("session.compact", { sessionId: state.current.id });
            const id = state.current.id;
            state.current = null;
            await openSession(id);
            addNote("compacted");
        } catch (err: any) {
            addError("compact failed: " + err.message);
        } finally {
            btn.disabled = false;
            btn.classList.remove("busy");
            btn.textContent = "compact";
            setRunning(false);
            drainQueue();
        }
    };

    /* Expand / collapse every tool, reasoning, and subagent row at once. */
    let toolsExpanded = false;
    byId("toggleTools").onclick = () => {
        toolsExpanded = !toolsExpanded;
        for (const det of blocks.querySelectorAll<HTMLDetailsElement>("details.row")) det.open = toolsExpanded;
        byId("toggleTools").textContent = toolsExpanded ? "collapse tools" : "expand tools";
    };

    /* Floating jump-to-latest button when scrolled up. */
    byId("transcript").addEventListener("scroll", function () {
        const away = this.scrollHeight - this.scrollTop - this.clientHeight;
        byId("scrollDown").classList.toggle("visible", away > 300);
    });
    byId("scrollDown").onclick = () => {
        const t = byId("transcript");
        t.scrollTop = t.scrollHeight;
    };

    /* Copy buttons (event delegation — blocks re-render constantly). */
    blocks.addEventListener("click", async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>(".copy-btn");
        if (!btn) return;
        const wrap = btn.closest(".codewrap");
        const text = wrap
            ? (wrap.querySelector("pre") as HTMLElement).innerText
            : (btn.closest<HTMLElement>(".block.assistant") || ({} as HTMLElement)).innerText || "";
        try {
            await navigator.clipboard.writeText(text.replace(/\ncopy$/, ""));
            btn.textContent = "copied";
            setTimeout(() => {
                btn.textContent = "copy";
            }, 1200);
        } catch {
            btn.textContent = "copy failed";
        }
    });
}
