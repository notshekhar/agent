/** Model picker: provider first, then model — the CLI's flow. */
import { byId } from "../lib/dom";
import { escapeHtml } from "../lib/format";
import { state } from "../state";

const picker: { stage: "providers" | "models"; provider: string | null } = {
    stage: "providers",
    provider: null,
};

function availableModels(): any[] {
    return state.catalog.filter((m) => m.available !== false);
}

function pickerProviders(): string[] {
    const authorized = new Set(state.authProviders);
    let provs = [...new Set(availableModels().map((m) => m.provider as string))];
    if (authorized.size) provs = provs.filter((p) => authorized.has(p));
    const curProv = state.selectedModel.includes("/") ? state.selectedModel.split("/")[0]! : "";
    if (curProv && !provs.includes(curProv)) provs.unshift(curProv);
    return provs.sort();
}

export function setModel(id: string): void {
    if (!id) return;
    state.selectedModel = id;
    if (state.current) state.current.model = id;
    byId("modelBtn").innerHTML = escapeHtml(id) + '<span class="chev">&#x25B4;</span>';
}

/* Initialize the button from a session's model / the server default. */
export function initModel(desiredModel: string): void {
    const desired =
        desiredModel ||
        state.selectedModel ||
        (state.serverInfo && state.serverInfo.defaults && state.serverInfo.defaults.model) ||
        "";
    setModel(desired || (availableModels()[0] || {}).id || "");
}

function openPicker(): void {
    picker.stage = "providers";
    picker.provider = null;
    byId("modelPop").classList.add("visible");
    const f = byId("modelPop").querySelector<HTMLInputElement>(".pfilter")!;
    f.value = "";
    renderPicker();
    f.focus();
}

export function closePicker(): void {
    byId("modelPop").classList.remove("visible");
}

function renderPicker(): void {
    const pop = byId("modelPop");
    pop.classList.toggle("models", picker.stage === "models");
    const q = pop.querySelector<HTMLInputElement>(".pfilter")!.value.trim().toLowerCase();
    const list = pop.querySelector<HTMLElement>(".plist")!;
    list.innerHTML = "";
    const add = (main: string, meta: string, cls: string, onclick: () => void) => {
        const btn = document.createElement("button");
        btn.className = "pitem " + cls;
        btn.innerHTML =
            '<span class="pmain">' + escapeHtml(main) + '</span><span class="pmeta">' + escapeHtml(meta) + "</span>";
        btn.onclick = onclick;
        list.appendChild(btn);
        return btn;
    };
    if (picker.stage === "providers") {
        const curProv = state.selectedModel.split("/")[0];
        const provs = pickerProviders().filter((p) => !q || p.toLowerCase().includes(q));
        if (!provs.length) list.innerHTML = '<div class="pempty">no providers match</div>';
        for (const p of provs) {
            const count = availableModels().filter((m) => m.provider === p).length;
            add(p, count + (count === 1 ? " model" : " models"), p === curProv ? "current" : "", () => {
                picker.stage = "models";
                picker.provider = p;
                const f = byId("modelPop").querySelector<HTMLInputElement>(".pfilter")!;
                f.value = "";
                renderPicker();
                f.focus();
            });
        }
    } else {
        const p = picker.provider!;
        let models = availableModels()
            .filter((m) => m.provider === p)
            .sort((a, b) => a.id.localeCompare(b.id));
        // A session model missing from the catalog stays selectable.
        if (state.selectedModel.split("/")[0] === p && !models.some((m) => m.id === state.selectedModel)) {
            models.unshift({ id: state.selectedModel, provider: p });
        }
        models = models.filter((m) => !q || m.id.toLowerCase().includes(q));
        if (!models.length) list.innerHTML = '<div class="pempty">no models match</div>';
        for (const m of models) {
            const bare = m.id.startsWith(p + "/") ? m.id.slice(p.length + 1) : m.id;
            const meta = m.cost ? "$" + m.cost.input + "/$" + m.cost.output : "";
            add(bare, meta, m.id === state.selectedModel ? "current" : "", () => {
                setModel(m.id);
                closePicker();
                byId("input").focus();
            });
        }
    }
}

export function wireModelPicker(): void {
    byId("modelBtn").onclick = (e) => {
        e.stopPropagation();
        if (byId("modelPop").classList.contains("visible")) closePicker();
        else openPicker();
    };
    byId("modelPop").addEventListener("click", (e) => e.stopPropagation());
    byId("modelPop").querySelector<HTMLButtonElement>(".pback")!.onclick = () => {
        picker.stage = "providers";
        const f = byId("modelPop").querySelector<HTMLInputElement>(".pfilter")!;
        f.value = "";
        renderPicker();
        f.focus();
    };
    const filter = byId("modelPop").querySelector<HTMLInputElement>(".pfilter")!;
    filter.addEventListener("input", renderPicker);
    filter.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closePicker();
            byId("input").focus();
        } else if (e.key === "Enter") {
            const first = byId("modelPop").querySelector<HTMLButtonElement>(".plist .pitem");
            if (first) first.click();
        } else if (e.key === "Backspace" && !(e.target as HTMLInputElement).value && picker.stage === "models") {
            byId("modelPop").querySelector<HTMLButtonElement>(".pback")!.click();
        }
    });
    document.addEventListener("click", () => closePicker());
}
