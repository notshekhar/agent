/** Extensions dialog — list built-in + installed, enable/disable in place.
 * Install/uninstall stay in the CLI (a remote page must not pull code). */
import { byId } from "../../lib/dom";
import { escapeHtml } from "../../lib/format";
import { rpc } from "../../services/connection";
import { setStatus } from "../../ui/status";
import { openDialog } from "./frame";

export async function showExtensions(): Promise<void> {
    openDialog("Extensions");
    try {
        const list = await rpc("extension.list");
        const body = byId("dialogBody");
        body.innerHTML = "";
        if (!list.length) {
            body.innerHTML =
                '<div class="home-empty">No extensions. Install one from the CLI: /install &lt;npm|github:owner/repo|path&gt;</div>';
            return;
        }
        for (const e of list) {
            const btn = document.createElement("button");
            btn.className = "set-row" + (e.enabled ? " on" : "");
            const badge = e.builtin ? "built-in" : e.version ? "v" + e.version : "installed";
            const desc = e.description || (e.linkPath ? "linked: " + e.linkPath : e.source || "");
            btn.innerHTML =
                '<span class="smain"><div class="slabel">' +
                escapeHtml(e.displayName || e.name) +
                "</div>" +
                '<div class="sdesc">' +
                escapeHtml(desc) +
                "</div></span>" +
                '<span class="sbadge">' +
                escapeHtml(badge) +
                "</span>" +
                '<span class="toggle"></span>';
            btn.onclick = async () => {
                const next = !btn.classList.contains("on");
                btn.classList.toggle("on", next);
                btn.disabled = true;
                try {
                    await rpc("extension.setEnabled", { name: e.name, value: next });
                } catch (err: any) {
                    btn.classList.toggle("on", !next); // revert on failure
                    setStatus("extensions: " + err.message);
                } finally {
                    btn.disabled = false;
                }
            };
            body.appendChild(btn);
        }
        const note = document.createElement("div");
        note.className = "ctx-marknote";
        note.style.marginTop = "12px";
        note.textContent = "toggles apply to new turns; freshly enabled slash commands need a server restart";
        body.appendChild(note);
    } catch (err: any) {
        byId("dialogBody").innerHTML =
            '<div class="block error">' + escapeHtml("failed to load extensions: " + err.message) + "</div>";
    }
}
