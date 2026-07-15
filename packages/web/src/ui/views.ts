/** View switching (home <-> chat) and the header breadcrumb, including
 * click-to-rename on the session title. */
import { byId } from "../lib/dom";
import { basename, sessionTitle } from "../lib/format";
import { rpc } from "../services/connection";
import { state } from "../state";
import { setRoute } from "./router";
import { setStatus } from "./status";
import { refreshSessions, renderHome } from "../features/home";
import { cancelTurn } from "../features/session";

export function showHome(): void {
    state.current = null;
    byId("chat").classList.remove("visible");
    byId("home").classList.add("visible");
    renderCrumb();
    renderHome();
    refreshSessions();
    byId("search").focus();
}

export function showChat(): void {
    byId("home").classList.remove("visible");
    byId("chat").classList.add("visible");
    renderCrumb();
    byId("input").focus();
}

export function renderCrumb(): void {
    const el = byId("crumb");
    el.innerHTML = "";
    const current = state.current;
    if (!current) {
        const span = document.createElement("span");
        span.className = "title";
        span.textContent = state.selectedProject ? basename(state.selectedProject) : "";
        el.appendChild(span);
        return;
    }
    const back = document.createElement("button");
    back.className = "back";
    back.textContent = "back";
    back.onclick = goHome;
    const proj = document.createElement("span");
    proj.className = "projseg";
    proj.textContent = basename(current.cwd);
    proj.style.color = "var(--faint)";
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "/";
    const title = document.createElement("span");
    title.className = "title";
    title.id = "sessionTitle";
    title.textContent = current.draft
        ? "new session"
        : current.name || sessionTitle(state.sessions.find((s) => s.id === current.id) || {});
    if (!current.draft) {
        title.classList.add("renamable");
        title.title = "click to rename";
        title.onclick = startRename;
    }
    el.append(back, proj, sep, title);
}

/* Click the breadcrumb title to rename the session (session.rename RPC). */
function startRename(): void {
    const current = state.current;
    if (!current || current.draft) return;
    const title = byId("sessionTitle");
    const input = document.createElement("input");
    input.className = "rename";
    input.value = current.name || title.textContent || "";
    title.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (save && name) {
            try {
                await rpc("session.rename", { sessionId: current.id, name });
                current.name = name;
                const s = state.sessions.find((x) => x.id === current.id);
                if (s) s.name = name;
            } catch (err: any) {
                setStatus("rename failed: " + err.message);
            }
        }
        renderCrumb();
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
        e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(false));
}

export function goHome(): void {
    if (state.running) cancelTurn();
    setRoute(null);
    showHome();
}
