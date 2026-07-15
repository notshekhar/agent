/** Settings dialog: toggle rows backed by settings.list / settings.set. */
import { byId } from "../../lib/dom";
import { escapeHtml } from "../../lib/format";
import { rpc } from "../../services/connection";
import { setStatus } from "../../ui/status";
import { openDialog } from "./frame";

export async function showSettings(): Promise<void> {
    openDialog("Settings");
    try {
        const list = await rpc("settings.list");
        const body = byId("dialogBody");
        body.innerHTML = "";
        for (const s of list) {
            const btn = document.createElement("button");
            btn.className = "set-row" + (s.value ? " on" : "");
            btn.innerHTML =
                '<span class="smain"><div class="slabel">' +
                escapeHtml(s.label) +
                '</div><div class="sdesc">' +
                escapeHtml(s.description) +
                "</div></span>" +
                '<span class="toggle"></span>';
            btn.onclick = async () => {
                const next = !btn.classList.contains("on");
                btn.classList.toggle("on", next);
                try {
                    await rpc("settings.set", { key: s.key, value: next });
                } catch (err: any) {
                    btn.classList.toggle("on", !next); // revert on failure
                    setStatus("settings: " + err.message);
                }
            };
            body.appendChild(btn);
        }
    } catch (err: any) {
        byId("dialogBody").innerHTML =
            '<div class="block error">' + escapeHtml("failed to load settings: " + err.message) + "</div>";
    }
}
