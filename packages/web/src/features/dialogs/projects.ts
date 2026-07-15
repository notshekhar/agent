/** Project picker dialog: filter by an existing project or open a new path.
 * Replaces the old inline open-project form — a real dialog works on touch
 * (backdrop tap + close button) where the form's Enter/Esc-only flow did not.
 * Pattern mirrors OpenCode's DialogSelectDirectory. */
import { byId } from "../../lib/dom";
import { basename, escapeHtml, hueOf } from "../../lib/format";
import { state } from "../../state";
import { renderCrumb } from "../../ui/views";
import { projectsOf, renderHome } from "../home";
import { newDraft } from "../session";
import { closeDialog, openDialog } from "./frame";

export function showProjectPicker(opts: { focusPath?: boolean } = {}): void {
    openDialog("Projects");
    const body = byId("dialogBody");
    body.innerHTML = "";

    const form = document.createElement("div");
    form.className = "pp-open";
    const input = document.createElement("input");
    input.placeholder = "/path/to/project";
    input.spellcheck = false;
    input.value = (state.serverInfo && state.serverInfo.defaults && state.serverInfo.defaults.cwd) || "";
    const go = document.createElement("button");
    go.textContent = "Open";
    const openPath = () => {
        const p = input.value.trim();
        if (!p) return;
        state.selectedProject = p;
        closeDialog();
        renderHome();
        renderCrumb();
        newDraft(p);
    };
    go.onclick = openPath;
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            openPath();
        }
    });
    form.append(input, go);

    const pick = (cwd: string | null) => {
        state.selectedProject = cwd;
        closeDialog();
        renderHome();
        renderCrumb();
    };

    const filter = document.createElement("input");
    filter.className = "pp-filter";
    filter.placeholder = "Filter projects";
    filter.spellcheck = false;

    const list = document.createElement("div");
    list.className = "pp-list";

    const renderList = () => {
        const q = filter.value.trim().toLowerCase();
        list.innerHTML = "";
        const all = document.createElement("button");
        all.className = "pp-row" + (state.selectedProject === null ? " active" : "");
        all.innerHTML =
            '<span class="avatar" style="background:var(--bg-raise);color:var(--muted)">*</span>' +
            '<span class="ppmain"><span class="ppname">All sessions</span></span>' +
            '<span class="count">' +
            state.sessions.length +
            "</span>";
        all.onclick = () => pick(null);
        if (!q || "all sessions".includes(q)) list.appendChild(all);

        let shown = list.childElementCount;
        for (const p of projectsOf(state.sessions)) {
            const name = basename(p.cwd);
            if (q && !name.toLowerCase().includes(q) && !p.cwd.toLowerCase().includes(q)) continue;
            const hue = hueOf(p.cwd);
            const btn = document.createElement("button");
            btn.className = "pp-row" + (state.selectedProject === p.cwd ? " active" : "");
            btn.innerHTML =
                '<span class="avatar" style="background:hsl(' +
                hue +
                " 30% 22%);color:hsl(" +
                hue +
                ' 70% 72%)">' +
                escapeHtml(name.slice(0, 2)) +
                "</span>" +
                '<span class="ppmain"><span class="ppname">' +
                escapeHtml(name) +
                '</span><span class="pppath">' +
                escapeHtml(p.cwd) +
                "</span></span>" +
                '<span class="count">' +
                (p.count || "") +
                "</span>";
            btn.onclick = () => pick(p.cwd);
            list.appendChild(btn);
            shown++;
        }
        if (!shown) {
            const empty = document.createElement("div");
            empty.className = "pp-empty";
            empty.textContent = "No projects match.";
            list.appendChild(empty);
        }
    };
    filter.addEventListener("input", renderList);
    renderList();

    body.append(form, filter, list);
    /* Opening a path: focus the path field. Filtering existing projects: focus
     * the filter so the keyboard is useful immediately. */
    requestAnimationFrame(() => {
        if (opts.focusPath) input.focus();
        else if (projectsOf(state.sessions).length > 4) filter.focus();
    });
}
