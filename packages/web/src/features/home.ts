/** Home screen: the projects rail and the grouped, searchable session list. */
import { byId } from "../lib/dom";
import { basename, dayGroup, escapeHtml, hueOf, relativeTime, sessionTitle } from "../lib/format";
import { client, rpc } from "../services/connection";
import { state } from "../state";
import { renderCrumb } from "../ui/views";
import { openSession } from "./session";

export async function refreshSessions(): Promise<void> {
    try {
        state.sessions = await rpc("session.list");
        renderHome();
    } catch {}
}

export function projectsOf(list: any[]): Array<{ cwd: string; count: number; mtime: number }> {
    const map = new Map<string, { cwd: string; count: number; mtime: number }>();
    for (const s of list) {
        const p = map.get(s.cwd) || { cwd: s.cwd, count: 0, mtime: 0 };
        p.count++;
        p.mtime = Math.max(p.mtime, s.mtime);
        map.set(s.cwd, p);
    }
    return [...map.values()].sort((a, b) => b.mtime - a.mtime);
}

export function renderHome(): void {
    if (!byId("home").classList.contains("visible")) return;
    const projs = projectsOf(state.sessions);
    if (state.selectedProject && !projs.some((p) => p.cwd === state.selectedProject)) {
        projs.unshift({ cwd: state.selectedProject, count: 0, mtime: Date.now() });
    }
    /* Mobile collapses the rail into one selector button — keep its label
     * pointing at the active filter. */
    byId("projSelect").querySelector<HTMLElement>(".psname")!.textContent = state.selectedProject
        ? basename(state.selectedProject)
        : "All sessions";
    const rail = byId("projects");
    rail.innerHTML = "";
    const all = document.createElement("button");
    all.className = "proj" + (state.selectedProject === null ? " active" : "");
    all.innerHTML =
        '<span class="avatar" style="background:var(--bg-raise);color:var(--muted)">*</span>' +
        '<span class="pname">All sessions</span><span class="count">' +
        state.sessions.length +
        "</span>";
    all.onclick = () => {
        state.selectedProject = null;
        renderHome();
        renderCrumb();
    };
    rail.appendChild(all);
    for (const p of projs) {
        const hue = hueOf(p.cwd);
        const btn = document.createElement("button");
        btn.className = "proj" + (state.selectedProject === p.cwd ? " active" : "");
        btn.title = p.cwd;
        btn.innerHTML =
            '<span class="avatar" style="background:hsl(' +
            hue +
            " 30% 22%);color:hsl(" +
            hue +
            ' 70% 72%)">' +
            escapeHtml(basename(p.cwd).slice(0, 2)) +
            "</span>" +
            '<span class="pname">' +
            escapeHtml(basename(p.cwd)) +
            "</span>" +
            '<span class="count">' +
            (p.count || "") +
            "</span>";
        btn.onclick = () => {
            state.selectedProject = p.cwd;
            renderHome();
            renderCrumb();
        };
        rail.appendChild(btn);
    }
    renderSessionGroups();
}

export function renderSessionGroups(): void {
    const q = byId<HTMLInputElement>("search").value.trim().toLowerCase();
    const el = byId("sessionGroups");
    el.innerHTML = "";
    let list = [...state.sessions].sort((a, b) => b.mtime - a.mtime);
    if (state.selectedProject) list = list.filter((s) => s.cwd === state.selectedProject);
    if (q) list = list.filter((s) => (sessionTitle(s) + " " + s.cwd).toLowerCase().includes(q));
    if (!list.length) {
        el.innerHTML =
            '<div class="home-empty">' +
            (state.sessions.length ? "No sessions match." : "No sessions yet — start one.") +
            "</div>";
        return;
    }
    let group = "";
    for (const s of list.slice(0, 200)) {
        const g = dayGroup(s.mtime);
        if (g !== group) {
            group = g;
            const h = document.createElement("div");
            h.className = "group-title";
            h.textContent = g;
            el.appendChild(h);
        }
        const row = document.createElement("button");
        row.className = "srow";
        row.innerHTML =
            (s.running ? '<span class="live" title="turn running"></span>' : "") +
            '<span class="stitle">' +
            escapeHtml(sessionTitle(s)) +
            "</span>" +
            (state.selectedProject ? "" : '<span class="schip">' + escapeHtml(basename(s.cwd)) + "</span>") +
            '<span class="stime">' +
            relativeTime(s.mtime) +
            "</span>";
        row.onclick = () => openSession(s.id);
        el.appendChild(row);
    }
}

export function wireHome(): void {
    byId("search").addEventListener("input", renderSessionGroups);
    /* Keep home's running-dots and previews fresh (cheap DB list). */
    setInterval(() => {
        if (client.connected && byId("home").classList.contains("visible")) refreshSessions();
    }, 5000);
}
