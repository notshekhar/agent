/** The shared modal frame every dialog renders into. */
import { byId } from "../../lib/dom";

export function openDialog(title: string): void {
    byId("dialogTitle").textContent = title;
    byId("dialogBody").innerHTML = '<div style="color:var(--faint)">loading…</div>';
    byId("dialogWrap").classList.add("visible");
}

export function closeDialog(): void {
    byId("dialogWrap").classList.remove("visible");
}

export function wireDialogFrame(): void {
    byId("dialogWrap").addEventListener("click", (e) => {
        if (e.target === byId("dialogWrap")) closeDialog();
    });
    byId("dialog").querySelector<HTMLButtonElement>(".dclose")!.onclick = closeDialog;
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && byId("dialogWrap").classList.contains("visible")) closeDialog();
    });
}
