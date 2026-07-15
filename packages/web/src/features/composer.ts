/** The composer: text input, send/stop, image attach (picker, paste,
 * drag-and-drop), and mobile-keyboard ergonomics. */
import { byId } from "../lib/dom";
import { state } from "../state";
import { goHome } from "../ui/views";
import { IMAGE_TYPES } from "./attachments";
import { attach as attachFile } from "./attachments-instance";
import { cancelTurn, sendPrompt } from "./session";

export function wireComposer(): void {
    byId("send").onclick = sendPrompt;
    byId("stop").onclick = cancelTurn;

    /* Touch keyboards have no Shift+Enter: there, Enter makes a newline and the
     * send button submits (messenger convention). Desktop keeps Enter-to-send. */
    const coarsePointer = matchMedia("(pointer: coarse)").matches;
    const input = byId<HTMLTextAreaElement>("input");

    /* Compact screens get the short placeholder: the long one wraps to two
     * lines and (with field-sizing) doubles the empty composer's height. */
    const compact = matchMedia("(pointer: coarse), (max-width: 700px)");
    const applyPlaceholder = () => {
        input.placeholder = compact.matches ? "Ask anything" : "Ask anything — Enter to send, Shift+Enter for newline";
    };
    applyPlaceholder();
    compact.addEventListener("change", applyPlaceholder);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !coarsePointer) {
            e.preventDefault();
            sendPrompt();
        } else if (e.key === "Escape") {
            if (state.running) cancelTurn();
            else goHome();
        }
    });

    byId("attachBtn").onclick = () => byId("fileInput").click();
    byId<HTMLInputElement>("fileInput").addEventListener("change", function () {
        for (const file of this.files || []) attachFile(file);
        this.value = ""; // same file re-attachable
        input.focus();
    });

    /* Autosize: CSS field-sizing grows the textarea with zero JS cost; only
     * browsers without it pay the per-keystroke scrollHeight reflow. */
    if (!CSS.supports("field-sizing", "content")) {
        input.addEventListener("input", function () {
            this.style.height = "auto";
            this.style.height = Math.min(this.scrollHeight, 240) + "px";
        });
    }

    /* Paste an image anywhere in the composer. */
    input.addEventListener("paste", (e) => {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        for (const item of items) {
            if (item.kind === "file" && IMAGE_TYPES.has(item.type)) {
                e.preventDefault();
                attachFile(item.getAsFile());
            }
        }
    });

    wireDragAndDrop(input);
}

/* Drag-and-drop: as soon as a file drag enters the window (chat open), the
 * whole viewport becomes a labeled drop target and the composer highlights.
 * Window-level listeners + a single overlay avoid the classic enter/leave
 * flicker as the drag crosses child elements. */
function wireDragAndDrop(input: HTMLTextAreaElement): void {
    const isFileDrag = (e: DragEvent) => {
        const types = (e.dataTransfer && e.dataTransfer.types) || [];
        return [...types].includes("Files");
    };
    const showDropZone = (on: boolean) => {
        byId("dropZone").classList.toggle("visible", on);
        byId("composer").classList.toggle("dragging", on);
    };
    window.addEventListener("dragenter", (e) => {
        if (!isFileDrag(e) || !byId("chat").classList.contains("visible")) return;
        e.preventDefault();
        showDropZone(true);
    });
    window.addEventListener("dragover", (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
    });
    /* Leaving the window: dragleave with no related target (or out-of-viewport). */
    window.addEventListener("dragleave", (e) => {
        if (
            e.relatedTarget === null &&
            (e.clientX <= 0 ||
                e.clientY <= 0 ||
                e.clientX >= innerWidth ||
                e.clientY >= innerHeight ||
                (e.clientX === 0 && e.clientY === 0))
        ) {
            showDropZone(false);
        }
    });
    window.addEventListener("drop", (e) => {
        e.preventDefault();
        showDropZone(false);
        if (!byId("chat").classList.contains("visible")) return;
        for (const file of (e.dataTransfer && e.dataTransfer.files) || []) attachFile(file);
        input.focus();
    });
    /* Esc also dismisses a stuck overlay (cancelled OS drag). */
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") showDropZone(false);
    });
}
