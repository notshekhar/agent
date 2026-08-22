/**
 * Interactive mode orchestrator: builds the TUI layout, wires state + deps
 * into the input handler / turn runner / command context, and kicks off
 * startup work. Behavior lives in the wired modules, not here.
 */
import {
    CombinedAutocompleteProvider,
    Container,
    Editor,
    ProcessTerminal,
    SelectList,
    type SelectItem,
    Spacer,
    Text,
    truncateToWidth,
    TUI,
    type Component,
    type EditorTheme,
    type SlashCommand as TuiSlashCommand,
} from "@notshekhar/loop-tui";
import {
    envName,
    CommandRegistry,
    CostTracker,
    SessionManager,
    registerBuiltins,
    getActiveProvider,
    settingsStore,
    getCatalog,
    parseModelId,
    ensureTool,
    runHooks,
    hookBus,
    closeAllPools,
    closeDb,
    getMcpManager,
    getExtensionHost,
    agentExists,
    isBuiltinAgent,
    isHiddenAgent,
    DEFAULT_AGENT_NAME,
    resolveSavedAgent,
    getProjectModel,
    latestTodos,
    setAskUserBridge,
    setBashApprovalBridge,
    getSetting,
    PRODUCT_NAME,
    type ThinkingLevel,
    type ProviderId,
    type Session,
    CONFIG_DIR_NAME,
} from "@notshekhar/loop-core";
import { getSelectListTheme, initUiModeAndTheme, theme } from "./ui/theme";
import { applyExtensionUiModes } from "./ui/ui-mode";
import { registerNoirMode } from "./ui/noir-mode";
import { probeSystemScheme, stopSystemSchemeProbes } from "./ui/system-scheme";
import { printResumeHint } from "./resume-hint";
import { applyCanvasWash, resetCanvasWash } from "./ui/canvas-wash";
import { ChatHistory } from "./components/chat-history";
import { renderSessionBranch } from "./replay";
import { StatusLine } from "./components/status-line";
import { TodoPanel } from "./components/todo-panel";
import { SelectorOverlay } from "./components/selector-overlay";
import {
    selectOnce as selectOnceShared,
    searchSelectOnce as searchSelectOnceShared,
    promptOnce as promptOnceShared,
    toggleSelectOnce,
} from "./selectors";
import { createAskUserBridge } from "./ask-user";
import { createBashApprovalBridge } from "./bash-approve";
import { createCommandContext } from "./command-handlers";
import { createInputHandler } from "./input-handler";
import { isEventTraceEnabled, setEventTraceSink, toggleEventTrace } from "./debug-log";
import { createTurnRunner } from "./turn-runner";
import { createStatusLineRefresher } from "./status-line-refresh";
import { createWorkingIndicator } from "./working-indicator";
import { createAgentStatusBus } from "./agent-status";
import { attachCmuxReporter, setCmuxReporter } from "./cmux-reporter";
import { attachTerminalTitle, defaultTabName } from "./session-title";
import { attachHerdrReporter } from "./herdr-reporter";
import { createTicker } from "./ticker";
import { registerAppKeybindings } from "./app-keybindings";
import { installConsoleBridge } from "./console-bridge";
import { runStartupTrustAndHooks, showWhatsNew, showWorkspaceBanners, startUpdateCheck } from "./startup";
import { startEnabledGateways, stopSpawnedGateways } from "./gateway-process";
import { showWelcomeBanner } from "./welcome";
import { listUsableProviders } from "./provider-availability";
import { openBrowser } from "../open-browser";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";
import { dim, muted, warn } from "./ui/text";

export interface InteractiveOptions {
    modelId?: string;
    provider?: ProviderId;
    cwd: string;
    sessionId?: string;
    version?: string;
}

/**
 * A single queued user message, rendered on exactly one line: newlines are
 * collapsed to spaces and anything past the viewport width is cut to a trailing
 * "…" (matching the user-message selector). Keeps the pending list compact no
 * matter how long or multi-line the queued input was.
 */
class PendingMessageLine implements Component {
    constructor(
        private readonly prefix: string,
        private readonly message: string,
    ) {}
    invalidate(): void {}
    render(width: number): string[] {
        const singleLine = this.message.replace(/\s+/g, " ").trim();
        const avail = Math.max(1, width - this.prefix.length);
        return [dim(this.prefix) + muted(truncateToWidth(singleLine, avail))];
    }
}

/**
 * The composer's chrome. Resolved per call rather than captured once: `/theme`
 * and `/uimode` swap the active theme mid-session, and a captured colour
 * function would keep painting the old palette until restart.
 */
const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg("inputBorder", s),
    commandColor: (s) => theme.fg("inputCommand", s),
    get selectList() {
        return getSelectListTheme();
    },
};

/**
 * No model is selected at startup. Point the user at the right next step: if
 * they have no usable provider at all, they must /login; if a provider is
 * available (logged in or a detected ollama) they just need to pick one with
 * /provider (or /login into another).
 */
async function showNoModelGuidance(history: ChatHistory, tui: TUI): Promise<void> {
    const providers = await listUsableProviders();
    if (providers.length === 0) {
        history.addSystem(warn("No model selected and no provider available. Run /login to get started."));
    } else {
        history.addSystem(
            warn(`No model selected. Run /provider to pick one (${providers.join(", ")}), or /login to add another.`),
        );
    }
    tui.requestRender();
}

export async function runInteractive(opts: InteractiveOptions): Promise<void> {
    registerNoirMode();
    initUiModeAndTheme();
    registerAppKeybindings();

    // Model precedence: CLI flag > this folder's last pick > global default.
    // No silent provider fallback — if the user never picked a model we leave
    // it empty and guide them to /login or /provider instead of defaulting to
    // some provider they may not even be authenticated for.
    let initialModelId =
        opts.modelId ?? getProjectModel(opts.cwd) ?? (settingsStore.get("defaultModel") as string | undefined) ?? "";

    const manager = new SessionManager();
    const initialSession: Session | null = opts.sessionId ? await manager.open(opts.sessionId) : null;
    const resumedModel = initialSession?.lastModel();
    if (resumedModel) initialModelId = resumedModel;
    // Provider follows the restored model (project/session picks carry it);
    // otherwise the active provider, if any.
    let effectiveProvider = (opts.provider ?? getActiveProvider() ?? "") as ProviderId;
    if (initialModelId) {
        try {
            effectiveProvider = parseModelId(initialModelId).provider as ProviderId;
        } catch {
            // unparseable id — keep the active provider
        }
    }

    const tracker = new CostTracker();
    // Resumed sessions restore their cost/usage/ctx from the transcript's
    // usage entries instead of showing zeros until the next message.
    const seededCtxTokens = initialSession ? tracker.seedFromSession(initialSession).ctxTokens : 0;
    // Load extensions BEFORE building commands so registerBuiltins (which lists
    // agents) sees extension-registered agents and gives them /<name> commands.
    // With nothing installed this is a no-op, so the command set is exactly the
    // builtins.
    // Give extensions a browser opener before activate() runs. The interactive
    // `ui` bridge is injected later, once the TUI selector helpers exist.
    getExtensionHost().setServices({ openExternal: (url) => openBrowser(url) });
    await getExtensionHost().init();
    // Modes an extension registers must exist before the configured mode is
    // activated, so drain them and re-resolve the mode + its theme.
    applyExtensionUiModes();
    initUiModeAndTheme();
    const commands = new CommandRegistry();
    await registerBuiltins(commands, { cwd: opts.cwd });
    getExtensionHost().applyCommands(commands);

    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);

    const history = new ChatHistory(tui, opts.cwd);
    const statusLine = new StatusLine();
    const todoPanel = new TodoPanel();
    // A resumed session restores its branch's latest checklist immediately.
    if (initialSession) todoPanel.setItems(latestTodos(initialSession.getBranch()) ?? []);
    statusLine.setModel(initialModelId);
    statusLine.setSession(initialSession?.id ?? "unsaved");
    statusLine.setCost(tracker.format());
    statusLine.setCostData(tracker.sessionBreakdown());
    statusLine.setCwd(opts.cwd);
    const initialThinking: ThinkingLevel = (settingsStore.get("thinkingLevel") as ThinkingLevel | undefined) ?? "off";
    statusLine.setThinking(initialThinking);

    // Plan is a per-session mode, not a sticky preference: a new loop always
    // boots in the default agent even if the last session ended in plan.
    const savedAgent = resolveSavedAgent(settingsStore.get("agent") as string | undefined) ?? DEFAULT_AGENT_NAME;
    const state: AppState = {
        cwd: opts.cwd,
        modelId: initialModelId,
        provider: effectiveProvider,
        thinkingLevel: initialThinking,
        agent: agentExists(savedAgent) ? savedAgent : DEFAULT_AGENT_NAME,
        oneShotAgent: null,
        cycleCustomAgent:
            agentExists(savedAgent) && (!isBuiltinAgent(savedAgent) || isHiddenAgent(savedAgent)) ? savedAgent : null,
        session: initialSession,
        latestContextTokens: seededCtxTokens,
        busy: false,
        scrollbackFocus: false,
        pinnedInput: Boolean(settingsStore.get("pinnedInput")),
        abort: new AbortController(),
        pendingInjection: null,
        lastCtrlCAt: 0,
        startupHooksDone: null,
        pendingPlan: null,
        planModeViaCycle: false,
        timerEndsAt: null,
        timerLabel: "",
    };
    statusLine.setAgent(state.agent);

    const { refreshStatusLine, refreshStatusLineCtx } = createStatusLineRefresher(statusLine, tracker, tui, state);
    refreshStatusLineCtx();

    const editor = new Editor(tui, editorTheme, { paddingX: 1 });

    // @-mention fuzzy file search needs the `fd` binary; without it the provider
    // silently returns no file suggestions. Resolve it once (from PATH, else
    // download) and rebuild the provider when ready. `null` until then — slash
    // commands and explicit path completion still work in the meantime.
    let fdPath: string | null = null;
    const refreshCommands = () => {
        const slashItems: TuiSlashCommand[] = commands.list().map((c) => ({
            name: c.name,
            description: c.description,
        }));
        editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashItems, state.cwd, fdPath));
    };
    refreshCommands();
    void ensureTool("fd", true).then((path) => {
        if (!path) return;
        fdPath = path;
        refreshCommands();
    });

    // Editor lives in its own container so we can swap it out for selectors
    const editorContainer = new Container();
    editorContainer.addChild(editor);

    // Fixed-height status slot above editor so editor never shifts.
    // Loader renders 2 rows (leading blank + spinner line) — the idle spacer
    // must match, or the editor/status line block jumps a row on every turn start.
    const statusContainer = new Container();
    const statusIdleSpacer = new Spacer(2);
    statusContainer.addChild(statusIdleSpacer);

    // queued user messages render between status and editor
    const pendingContainer = new Container();
    const queuedMessages: string[] = [];
    function renderPending(): void {
        pendingContainer.clear();
        for (let i = 0; i < queuedMessages.length; i++) {
            pendingContainer.addChild(
                new PendingMessageLine(` queued ${i + 1}/${queuedMessages.length}: `, queuedMessages[i]),
            );
        }
    }

    const root = new Container();
    root.addChild(history);
    root.addChild(statusContainer);
    // Pinned checklist: below the loader slot, above queued messages + editor.
    root.addChild(todoPanel);
    root.addChild(pendingContainer);
    root.addChild(editorContainer);
    root.addChild(statusLine);
    // Constant breathing room below the status line — without it the status block
    // sits flush with the terminal's bottom row once the screen fills up.
    root.addChild(new Spacer(1));
    tui.addChild(root);

    // What the transcript window may NOT use: every row the chrome under it is
    // taking this frame (loader slot, todos, queued messages, editor, status
    // line, trailing spacer). Measured rather than assumed, because all of it
    // moves — the editor grows a row per line of draft, the todo panel appears
    // mid-turn — and an under-reserve is what pushes the pinned prompt off the
    // screen. Re-rendering to measure is safe: component renders are pure (the
    // spinner advances on its own interval, not on render), the same property
    // the click-to-select mapper already relies on, and the transcript itself
    // is NOT re-rendered here — it is the one child this skips.
    //
    // Do not "optimize" this into a cached height — a height cached ACROSS
    // frames is stale in exactly the case that matters, the frame where the
    // editor grows a line, and a one-frame under-reserve is a one-frame
    // overflow of the screen.
    //
    // Memoizing WITHIN a single frame is a different thing, and safe: the
    // answer cannot change while one frame is being composed. Worth doing
    // because the measurement is only ~1µs on an empty draft — the editor has
    // no render cache of its own and re-lays out the whole draft on every call
    // (measured 0.05ms at 400 chars, 0.31ms at 4k, 1.2ms at 20k) — and a
    // pinned frame asks twice, once here and once when the chrome is really
    // rendered. The memo is dropped the moment the render pass ends, so
    // anything asking BETWEEN frames (PgUp sizing its page) still measures the
    // chrome as it is right then.
    let reserve: { frame: number; rows: number } | null = null;
    history.setReserveRows(() => {
        const rendering = tui.isRendering();
        if (rendering && reserve?.frame === tui.renderFrameId) return reserve.rows;
        const width = tui.terminal.columns;
        let rows = 0;
        for (const child of root.children) {
            if ((child as unknown) === (history as unknown)) continue;
            rows += child.render(width).length;
        }
        reserve = rendering ? { frame: tui.renderFrameId, rows } : null;
        return rows;
    });

    /**
     * Turn the pinned prompt on/off live (startup + the /settings row).
     *
     * The wheel is the point of the mouse reporting: without it the terminal
     * scrolls its own scrollback and the window under the prompt never moves.
     * The cost is that the terminal stops seeing drags as selections while it
     * is on, so it goes back off the moment the setting does.
     */
    const applyPinnedInput = (on: boolean): void => {
        state.pinnedInput = on;
        history.setPinned(on);
        tui.requestRender(true);
    };

    showWhatsNew(history, opts.version, Boolean(opts.sessionId));
    // Routes its result to the welcome banner (top), not chat history; safe to
    // kick off before the banner exists — the notice is remembered and applied.
    startUpdateCheck(opts.version);

    // Force a catalog availability refresh on every startup — provider model
    // lists drift (new releases, deprecations, gating) and the cached list is
    // good for up to 1h otherwise. Fire-and-forget; mergedCache rebuilds when
    // this lands so the /model picker reflects today's reality.
    void getCatalog({ refresh: true })
        .catch(() => {})
        .then(() => {
            // The catalog (including custom-provider models) resolves
            // asynchronously; the status line booted before it landed, so a
            // model that isn't resolvable synchronously — a custom-provider id —
            // came up with reasoning unknown and hid the thinking level. Re-apply
            // now that getModelSync can see it, then repaint.
            statusLine.setModel(state.modelId);
            tui.requestRender();
        });

    const workingIndicator = createWorkingIndicator(tui, statusContainer, statusIdleSpacer);

    // Agent-status bus: the semantic working/blocked/idle state of this pane.
    // Fed by the two seams that already see everything — the working
    // indicator (turns, compaction, hook commands, goal mode, Esc-interrupt)
    // and showSelector below (every modal prompt). Consumed by agent-state
    // watchers: the herdr reporter and the Notification hook bridge.
    const agentStatus = createAgentStatusBus();
    const showWorking = (message?: string): void => {
        agentStatus.setWorking();
        workingIndicator.showWorking(message);
    };
    const hideWorking = (): void => {
        agentStatus.setIdle();
        workingIndicator.hideWorking();
    };

    // herdr agent-state reporting (inert outside a herdr pane).
    const herdr = attachHerdrReporter(agentStatus, {
        getSession: () => (state.session ? { id: state.session.id, path: state.session.path } : null),
        disabled: getSetting("herdr") === false,
    });

    // cmux integration (inert outside a cmux pane). Unlike herdr's this one
    // does not read the status bus: cmux speaks lifecycle EVENTS, and loop
    // already emits every one of them as a hook — including the Notification
    // the bus fires below. It is registered globally because the approval and
    // ask bridges, built further down, ask for it at prompt time.
    const cmuxReporter = attachCmuxReporter(agentStatus, {
        getSession: () => (state.session ? { id: state.session.id, path: state.session.path } : null),
        cwd: () => state.cwd,
        disabled: getSetting("cmux") === false,
    });
    setCmuxReporter(cmuxReporter);

    // Name the tab immediately. A resumed session carries its own title; a
    // fresh one says which agent this pane is until its first turn earns one —
    // either beats the stale shell command a terminal shows otherwise, which
    // is what cmux was rendering on loop's pane card.
    const titleDeps = { tui } as unknown as AppDeps;
    const stopTerminalTitle = attachTerminalTitle(agentStatus, titleDeps, state.session?.getName() || defaultTabName());

    // Notification hook on agent-driven waits (Claude Code parity): when a
    // prompt opens mid-turn, external watchers get the "needs attention"
    // signal — same event the PreToolUse-denial path in core fires. Gated on
    // state.busy so user-opened menus (/provider, /theme) don't ping.
    agentStatus.on((e) => {
        if (e.status !== "blocked" || !state.busy) return;
        void runHooks(
            "Notification",
            undefined,
            {
                session_id: state.session?.id,
                transcript_path: state.session?.path,
                message: `Waiting for input: ${e.label ?? "prompt"}`,
                title: PRODUCT_NAME,
            },
            state.cwd,
        ).then((n) => {
            for (const s of n.terminalSequences) process.stdout.write(s);
        });
    });

    /**
     * Rows between the bottom of the frame and the bottom of the SCREEN.
     *
     * A frame at least as tall as the terminal ends on the last row and this is
     * zero. A shorter one — a fresh session, a short transcript with pinning
     * off — ends higher, and an overlay aimed at the screen's last row would
     * come adrift from the prompt and float underneath it. Overlays add this to
     * their bottom margin so they land on the frame instead of on the screen.
     */
    const rowsBelowFrame = (): number => Math.max(0, tui.terminal.rows - tui.getContentHeight());

    /** Rows of the frame that sit BELOW the editor: the status line, the spacer. */
    const rowsBelowEditor = (): number => {
        const width = tui.terminal.columns;
        let rows = 0;
        let seenEditor = false;
        for (const child of root.children) {
            if ((child as unknown) === (editorContainer as unknown)) {
                seenEditor = true;
                continue;
            }
            if (seenEditor) rows += child.render(width).length;
        }
        return rows;
    };

    // The completion list (`/`, `@`) is painted over the transcript instead of
    // being appended to the editor, for the reason every overlay here exists:
    // appended, it makes the frame taller for as long as it is open, the
    // terminal scrolls to fit it, and the rows that scrolled off cannot come
    // back when it closes — one `/` typed and deleted leaves a band behind.
    // Drawn over the frame it costs no height, so nothing scrolls either way.
    //
    // It sits directly above the editor rather than below it, which is where
    // the room is once it is no longer allowed to make any.
    //
    // Held open for the whole session and gated on `visible`: the list comes
    // and goes on nearly every keystroke, and an overlay that is registered
    // but not visible costs the frame nothing.
    editor.setPopupHosted(true);
    tui.showOverlay(
        {
            render: (width: number) => editor.renderAutocompletePopup(width),
            invalidate: () => {},
        },
        {
            width: "100%",
            maxHeight: "100%",
            anchor: "bottom-left",
            margin: () => ({
                bottom: rowsBelowFrame() + rowsBelowEditor() + editorContainer.render(tui.terminal.columns).length,
            }),
            visible: () => editor.isShowingAutocomplete(),
            // The editor keeps the keys: the list is driven through it, the
            // same as when it drew the rows itself.
            nonCapturing: true,
        },
    );

    // Open-selector count — timer/reminder prompts wait until the slot is free.
    let selectorDepth = 0;
    function showSelector(component: Container, focusable: Container | SelectList, label?: string): () => void {
        selectorDepth++;
        // Every modal prompt passes through here — but only agent-driven
        // waits (labeled: ask tool, approvals) count as blocked for watchers.
        // User-opened menus (/settings, pickers) are not the agent waiting.
        const modalClosed = label ? agentStatus.modalOpened(label) : undefined;

        // Swapping the selector in for the editor makes the frame taller, and a
        // frame that reaches the bottom of the screen answers that by
        // scrolling — which commits the rows at the top to the terminal's
        // scrollback, where they cannot be taken back. Closing the selector
        // shortens the frame again, those rows cannot come home, and the prompt
        // is left that much higher. Toggling pinned input in /settings is the
        // sharpest version: the menu itself pushed twelve rows off, so the
        // setting looked like it did nothing.
        //
        // Painted OVER the frame, a selector costs it no rows at all — nothing
        // scrolls going in, so there is nothing to give back coming out. It is
        // anchored to the bottom of the FRAME (rowsBelowFrame), not the bottom
        // of the screen, so a short transcript keeps the menu on the prompt
        // instead of leaving it floating at the bottom of the terminal.
        const overlay = tui.showOverlay(
            new SelectorOverlay(component, () => editorContainer.render(tui.terminal.columns).length),
            {
                width: "100%",
                // Never taller than the room it has: an overlay the frame must
                // grow for is a scroll again.
                maxHeight: "100%",
                anchor: "bottom-left",
                margin: () => ({ bottom: rowsBelowFrame() + rowsBelowEditor() }),
                // Focus goes to the inner list, not the wrapper.
                nonCapturing: true,
            },
        );
        tui.setFocus(focusable as never);
        tui.invalidate();
        tui.requestRender();
        return () => {
            selectorDepth--;
            modalClosed?.();
            overlay.hide();
            tui.setFocus(editor);
            tui.invalidate();
            tui.requestRender();
        };
    }

    const selectorHost = { tui, showSelector };
    const selectOnce = (items: SelectItem[], title?: string, opts?: { initialIndex?: number }) =>
        selectOnceShared(selectorHost, items, title, opts);
    const searchOnce = (items: SelectItem[], title?: string, opts?: { initialIndex?: number }) =>
        searchSelectOnceShared(selectorHost, items, title, opts);
    const promptOnce = (label?: string, initial?: string) =>
        promptOnceShared(selectorHost, editorTheme, label, initial);
    const toggleOnce = (values: string[], initial: Set<string>, title?: string) =>
        toggleSelectOnce(selectorHost, values, initial, title);

    // Expose the interactive menus/prompts to extensions (api.ui). SelectItem is
    // structurally identical to the extension API's UiSelectItem, so the lists
    // pass straight through. Used by extension command handlers, which only run
    // once the app is interactive — so wiring it here (after init) is fine.
    getExtensionHost().setServices({
        ui: {
            select: (items, title, opts) => selectOnce(items, title, opts),
            search: (items, title, opts) => searchOnce(items, title, opts),
            prompt: (label, initial) => promptOnce(label, initial),
            note: (text) => {
                history.addSystem(text);
                tui.requestRender();
            },
            error: (text) => {
                history.addError(text);
                tui.requestRender();
            },
        },
        // Lets a live status line (e.g. the vitals layout's clock/CPU) repaint
        // itself between user actions.
        requestRender: () => tui.requestRender(),
    });

    // Ask tool UI bridge — registering it is also what makes runTurn offer the
    // tool at all (print mode never registers, so no gate needed there).
    setAskUserBridge(createAskUserBridge({ host: selectorHost, editorTheme }));

    // Bash approval bridge — only registered here (interactive), so the
    // bashApprove setting has no effect in print mode / RPC. The setting
    // itself is checked in the bash tool; the bridge is just the UI.
    setBashApprovalBridge(createBashApprovalBridge(selectorHost));

    async function ensureSession(): Promise<Session> {
        if (state.session) return state.session;
        state.session = await manager.create({ cwd: state.cwd, provider: state.provider, model: state.modelId });
        statusLine.setSession(state.session.id);
        return state.session;
    }

    async function resolveModelId(input: string): Promise<string | null> {
        const cat = await getCatalog();
        if (cat[input]) return input;
        if (!input.includes("/")) {
            const active = (getActiveProvider() ?? state.provider) as ProviderId;
            const candidate = `${active}/${input}`;
            if (cat[candidate]) return candidate;
            const matches = Object.keys(cat).filter((k) => k.endsWith(`/${input}`));
            if (matches.length === 1) return matches[0];
        }
        try {
            parseModelId(input);
            return input;
        } catch {
            return null;
        }
    }

    // Shared 1s ticker (status line clock, /timer countdown, reminder scheduler);
    // owns its own timer/reminder/notice state and runs only while needed.
    const { syncTicker, stopTicker } = createTicker({
        state,
        statusLine,
        tui,
        getSelectorDepth: () => selectorDepth,
        selectOnce,
    });

    const restoreConsole = installConsoleBridge(history, tui);

    // Event tracer: dim trace lines in the chat + ~/.loop/events-debug.log.
    // Off by default; LOOP_DEBUG_EVENTS=1 enables at startup, Shift+Ctrl+D
    // toggles at runtime.
    setEventTraceSink((line) => {
        history.addSystem(dim(`· ${line}`));
        tui.requestRender();
    });
    tui.onDebug = () => {
        const on = toggleEventTrace();
        history.addSystem(dim(`· event trace ${on ? "ON" : "off"} → ~/${CONFIG_DIR_NAME}/events-debug.log`));
        tui.requestRender();
    };
    if (isEventTraceEnabled()) {
        history.addSystem(dim(`· event trace ON (${envName("DEBUG_EVENTS")}) — Shift+Ctrl+D to toggle`));
    }

    // (Active-extensions banner is shown by showWorkspaceBanners, grouped with
    // the workspace-context lines — see below.)
    // Surface any extension load failures (version mismatch, throw in activate),
    // so a broken extension is visible instead of silently missing.
    for (const w of getExtensionHost().getWarnings()) history.addError(`extension: ${w}`);

    const cleanExit = (code = 0) => {
        stopTicker();
        // Clear the OSC 9;4 tab progress bar before leaving the TUI.
        hideWorking();
        // BEFORE tui.stop(): a query still in flight when the TUI lets go of
        // stdin is answered into the SHELL.
        stopSystemSchemeProbes();
        tui.stop();
        // Give the terminal its own background back (OSC 111; no-op unwashed).
        resetCanvasWash();
        printResumeHint(state.session?.id);
        // Put the tab back to a plain name: whatever spinner frame was showing
        // would otherwise be the last thing this terminal was told.
        stopTerminalTitle();
        // Tear down MCP transports (stdio subprocesses, sockets) on the way out.
        void getMcpManager().close();
        // Gateway daemons are separate processes, but not immortal ones: stop
        // the daemons this loop spawned so a phone bridge never keeps polling
        // (and running shell commands) after the loop that owns it is gone.
        stopSpawnedGateways();
        // Run extensions' deactivate() so they can release resources.
        void getExtensionHost().close();
        // Close any open datasource connection pools.
        void closeAllPools();
        // SessionEnd hooks + herdr/cmux release: give them a moment, then exit
        // regardless. Release hands the pane back to herdr's own detection so
        // the sidebar doesn't keep showing a stale loop state, and drops the
        // cmux resume binding for a session that is not coming back.
        void Promise.race([
            Promise.allSettled([
                runHooks(
                    "SessionEnd",
                    undefined,
                    { session_id: state.session?.id, transcript_path: state.session?.path, reason: "exit" },
                    state.cwd,
                ),
                herdr.release(),
                cmuxReporter.release(),
            ]),
            new Promise((r) => setTimeout(r, 3_000)),
        ]).finally(() => {
            // Checkpoint + close the session DB last — SessionEnd hooks above
            // may still read it, and bun:sqlite close is synchronous.
            closeDb();
            process.exit(code);
        });
    };

    const deps: AppDeps = {
        tui,
        history,
        statusLine,
        todoPanel,
        tracker,
        editor,
        commands,
        manager,
        queuedMessages,
        refreshStatusLine,
        refreshStatusLineCtx,
        renderPending,
        showWorking,
        hideWorking,
        showSelector,
        getSelectorDepth: () => selectorDepth,
        selectOnce,
        searchOnce,
        toggleOnce,
        promptOnce,
        resolveModelId,
        ensureSession,
        cleanExit,
        refreshCommands,
        version: opts.version,
        restoreConsole,
        syncTicker,
        applyPinnedInput,
    };
    syncTicker();

    showWelcomeBanner(history, state, deps);
    // The startup block (workspace context, skills, extensions, the no-model
    // hint) goes in BEFORE the transcript, not after it.
    //
    // Both of these are awaited, and both used to run after the replay below,
    // which put the header's own status lines underneath the entire resumed
    // conversation — `loop --session <id>` opened on a screen whose last lines
    // were "workspace context: none" and "extensions: …" instead of the end of
    // the chat. Nothing is painted until tui.start() further down, so paying
    // for these two awaits here costs the first frame nothing.
    await showWorkspaceBanners(history, state.cwd);
    if (!state.modelId) await showNoModelGuidance(history, tui);
    // A session opened via --session replays its transcript like /resume does
    // — reopening a conversation without its history looked like data loss.
    // After the banner and its status block: the conversation goes below both.
    if (initialSession) renderSessionBranch(initialSession, history, state.modelId, todoPanel);

    const ctx = createCommandContext(state, deps);
    tui.addInputListener(createInputHandler(state, deps, ctx));
    editor.onSubmit = createTurnRunner(state, deps, ctx);

    // Plugin hooks ship statusMessage ("Loading caveman mode…") — transient
    // "while running" text, so it rides the loader, never the chat (a chat line
    // per prompt would spam every turn). Loader restores when the hook ends.
    let hookStatusDepth = 0;
    hookBus.on("start", (e: { statusMessage?: string }) => {
        if (!e.statusMessage) return;
        hookStatusDepth++;
        showWorking(e.statusMessage);
    });
    hookBus.on("end", (e: { statusMessage?: string }) => {
        if (!e.statusMessage) return;
        hookStatusDepth = Math.max(0, hookStatusDepth - 1);
        if (hookStatusDepth === 0) {
            if (state.busy) showWorking("Generating");
            else hideWorking();
        }
    });

    tui.setFocus(editor);
    tui.start();
    // After start: terminal.start() cleanses stale modes (incl. OSC 111
    // background reset), so the mode's wash must be applied after it.
    applyCanvasWash();
    // noir's `system` theme has no canvas of its own — it needs to know what
    // the terminal's background IS. One probe, in the background, and only
    // when that theme is what's rendering.
    probeSystemScheme(tui);
    // Same reason, and the same trap: the cleanse writes `?1000l ?1006l`, so a
    // pinned prompt asking for wheel reports BEFORE start() has its request
    // wiped a few thousand bytes into the first paint. The window still
    // scrolls on any wheel report it is handed — it just never gets handed
    // one, because the terminal was told to stop sending them and keeps the
    // wheel for its own scrollback.
    if (state.pinnedInput) applyPinnedInput(true);
    tui.requestRender();

    // Catalog warm-up: models change between releases — kick the
    // stale-while-revalidate refresh now (background; serves cache instantly)
    // so the model list and availability are fresh for this session.
    void getCatalog().catch(() => {});

    // Trust prompt + SessionStart hooks; the first turn awaits this so
    // hook-injected context isn't lost to a fast first prompt.
    state.startupHooksDone = runStartupTrustAndHooks(state, deps);

    // Gateways: bring up the daemon for each enabled gateway (Telegram, …) as
    // its own separate process — not run in this one, and stopped again by
    // cleanExit. Spawn only, never blocks the UI.
    startEnabledGateways(deps);
}
