/** Entry point: composition only. Connects the RPC client, boots initial
 * state, and wires each feature to its DOM. All behavior lives in the
 * feature/ui modules. */
import { byId } from "./lib/dom";
import { client, handlers, rpc, token } from "./services/connection";
import { state } from "./state";
import { routedSessionId } from "./ui/router";
import { setRunning, setStatus } from "./ui/status";
import { showHome } from "./ui/views";
import { wireChatTools } from "./features/chat-tools";
import { wireComposer } from "./features/composer";
import { closeDialog, wireDialogFrame } from "./features/dialogs/frame";
import { showContext } from "./features/dialogs/context";
import { showExtensions } from "./features/dialogs/extensions";
import { showSettings } from "./features/dialogs/settings";
import { showUsage } from "./features/dialogs/usage";
import { onEvent } from "./features/events";
import { projectsOf, renderHome, wireHome } from "./features/home";
import { initModel, wireModelPicker } from "./features/model-picker";
import { newDraft, openSession } from "./features/session";

async function boot(): Promise<void> {
    try {
        state.serverInfo = await rpc("server.info");
        const [list, cat, auth] = await Promise.all([rpc("session.list"), rpc("catalog.list"), rpc("auth.status")]);
        state.sessions = list;
        state.catalog = cat;
        state.authProviders = auth.providers || [];
        initModel((state.current && state.current.model) || state.selectedModel || "");
        byId<HTMLInputElement>("openPath").value = (state.serverInfo.defaults && state.serverInfo.defaults.cwd) || "";
        byId("overlay").classList.add("hidden");
        const current = state.current;
        if (current && !current.draft) {
            // Reconnect with a session open: re-attach after the last seq we
            // saw — the server replays exactly the missed events, so the
            // transcript catches up in place instead of re-rendering.
            try {
                const att = await rpc("session.attach", { sessionId: current.id, afterSeq: state.lastSeq });
                if (att.resync) {
                    // Gap outlived the replay ring — full re-render.
                    state.current = null;
                    await openSession(current.id!);
                } else {
                    setRunning(att.running);
                }
            } catch {
                state.current = null;
                await openSession(current.id!);
            }
        } else if (!current) {
            // Fresh load: the URL wins — /session/<id> reopens that session.
            const routed = routedSessionId();
            if (routed) openSession(routed);
            else showHome();
        }
        setStatus("");
    } catch (err: any) {
        byId("overlay").textContent =
            "failed to connect: " +
            err.message +
            (token ? "" : "\n\nno token in URL — open the exact URL `loop serve` printed");
        byId("overlay").classList.remove("hidden");
    }
}

/* Start a draft in the most relevant project: the open session's, the
 * selected one, the most recent, or the server's cwd. Reachable from
 * anywhere via the header button (closes any open dialog first). */
function startNewSession(): void {
    closeDialog();
    const cwd =
        (state.current && state.current.cwd) ||
        state.selectedProject ||
        (projectsOf(state.sessions)[0] || ({} as any)).cwd ||
        (state.serverInfo && state.serverInfo.defaults && state.serverInfo.defaults.cwd);
    if (!cwd) {
        showHome();
        byId("openProject").click();
        return;
    }
    newDraft(cwd);
}

function wireHeaderAndHome(): void {
    byId("newSession").onclick = startNewSession;
    byId("headerNew").onclick = startNewSession;
    byId("openProject").onclick = () => {
        byId("openForm").classList.toggle("visible");
        byId("openPath").focus();
    };
    byId<HTMLInputElement>("openPath").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const p = byId<HTMLInputElement>("openPath").value.trim();
            if (p) {
                state.selectedProject = p;
                byId("openForm").classList.remove("visible");
                renderHome();
                newDraft(p);
            }
        } else if (e.key === "Escape") {
            byId("openForm").classList.remove("visible");
        }
    });
    byId("usageBtn").onclick = showUsage;
    byId("extBtn").onclick = showExtensions;
    byId("settingsBtn").onclick = showSettings;
    byId("ctxBtn").onclick = showContext;
    byId("ctx").onclick = showContext;
}

function onRoute(): void {
    const id = routedSessionId();
    if (id) {
        if (!state.current || state.current.id !== id) openSession(id);
    } else if (state.current) {
        showHome();
    }
}

handlers.onOpen = () => {
    byId("conn").classList.add("ok");
    void boot();
};
handlers.onClose = () => {
    byId("conn").classList.remove("ok");
    setStatus("disconnected — reconnecting…");
};
handlers.onEvent = onEvent;

window.addEventListener("popstate", onRoute);
wireHeaderAndHome();
wireHome();
wireModelPicker();
wireComposer();
wireChatTools();
wireDialogFrame();
client.connect();
