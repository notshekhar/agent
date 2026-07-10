import type { CommandContext } from "@notshekhar/loop-core";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";
import {
    isAltDown,
    isAltUp,
    isCtrlC,
    isCtrlD,
    isCtrlDown,
    isCtrlE,
    isCtrlG,
    isCtrlI,
    isCtrlL,
    isCtrlP,
    isCtrlUp,
    isCtrlV,
    isDown,
    isEnd,
    isEnter,
    isEsc,
    isHome,
    isLeft,
    isPageDown,
    isPageUp,
    isPrintableChar,
    isRight,
    countWheelScroll,
    MOUSE_SGR_ANY,
    isShiftLeft,
    isShiftRight,
    isShiftTab,
    isTab,
    isUp,
} from "./keys";
import { isKeyRelease } from "@notshekhar/loop-tui";
import { copyToClipboard } from "./clipboard";
import { traceEvent } from "./debug-log";
import { pickImageFile, readClipboardImageToFile } from "./clipboard-image";
import {
    agentExists,
    extractImagesFromInput,
    getModelSync,
    getSetting,
    listAgents,
    settingsStore,
} from "@notshekhar/loop-core";

export type InputListener = (data: string) => { consume: boolean } | undefined;

// Terminals deliver both clipboard pastes and file drag-and-drop as a bracketed
// paste: ESC[200~ <content> ESC[201~ (the TUI re-wraps its paste event this way).
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

/** Whether the active model can actually accept image attachments. */
function modelAcceptsImages(modelId: string): boolean {
    const modalities = getModelSync(modelId)?.modalities;
    // Unknown modalities → assume images are fine (don't block on missing info).
    return !Array.isArray(modalities) || modalities.includes("image");
}

/**
 * If a paste / drag-and-drop is *purely* image file path(s) — nothing but the
 * path(s), modulo surrounding whitespace — return those paths so we can turn
 * them into attachments instead of dropping a raw, shell-escaped path into the
 * editor. Mixed pastes ("look at ./a.png") return null and fall through to the
 * editor untouched; submit-time extraction still handles those.
 */
function droppedImagePaths(data: string, cwd: string): string[] | null {
    const paste = BRACKETED_PASTE.exec(data);
    if (!paste) return null;
    const { textWithoutPaths, images } = extractImagesFromInput(paste[1], cwd);
    if (images.length === 0 || textWithoutPaths.trim() !== "") return null;
    return images.map((img) => img.path);
}

const SCROLLBACK_HINT =
    "nav · ↑/↓ select · shift+←/→ turn · →/← expand/fold · Enter toggle · e all · wheel/PgUp scroll · y copy · ctrl+e/Esc exit";

export function createInputHandler(state: AppState, deps: AppDeps, ctx: CommandContext): InputListener {
    const { tui, history, queuedMessages, renderPending, hideWorking, cleanExit, editor, statusLine } = deps;

    const enterScrollbackFocus = (): boolean => {
        if (!history.selectLast()) return false;
        state.scrollbackFocus = true;
        history.setViewport(true);
        statusLine.setHint(SCROLLBACK_HINT);
        // SGR mouse reporting, nav-scoped: the wheel scrolls the window here;
        // outside nav the terminal keeps native selection/copy behavior.
        tui.terminal.write("\x1b[?1006h\x1b[?1000h");
        tui.requestRender();
        return true;
    };

    const exitScrollbackFocus = (): void => {
        state.scrollbackFocus = false;
        history.setViewport(false);
        history.clearSelection();
        statusLine.setHint(null);
        tui.terminal.write("\x1b[?1000l\x1b[?1006l");
        if (wheelTimer) {
            clearTimeout(wheelTimer);
            wheelTimer = null;
            wheelAccum = 0;
        }
        tui.requestRender();
    };

    // Wheel deltas coalesce over a short window and apply as ONE net scroll:
    // macOS trackpads emit micro-events that alternate direction on slow
    // scrolls (lift-off/momentum jitter) — applied individually they made the
    // window flicker back and forth between the same lines.
    let wheelAccum = 0;
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    const WHEEL_COALESCE_MS = 30;
    const queueWheel = (delta: number): void => {
        wheelAccum += delta;
        if (wheelTimer) return;
        wheelTimer = setTimeout(() => {
            wheelTimer = null;
            const page = history.viewportPage();
            const net = Math.max(-page, Math.min(page, wheelAccum * 2));
            wheelAccum = 0;
            if (net !== 0 && state.scrollbackFocus) {
                history.scrollViewportLines(net);
                tui.requestRender();
            }
        }, WHEEL_COALESCE_MS);
    };

    const copySelected = (): void => {
        const text = history.getSelectedText();
        if (text === null) return;
        copyToClipboard(text, (ok) => {
            history.addSystem(
                ok
                    ? `copied ${text.length} chars to clipboard`
                    : `no clipboard tool available. content length: ${text.length}`,
            );
            tui.requestRender();
        });
    };

    /** Map a clicked screen row (1-based) to the chat history's own rendered
     * lines and select the entry there. Root components render top-aligned
     * until the content exceeds the screen, after which it bottom-aligns —
     * the offset accounts for both. Component renders are pure, so measuring
     * by re-rendering is safe (clicks are rare). */
    const selectAtScreenRow = (row: number): boolean => {
        const width = tui.terminal.columns;
        const children = (tui as unknown as { children: Array<{ render(w: number): string[] }> }).children;
        let before = 0;
        let total = 0;
        let historyHeight = -1;
        for (const c of children) {
            const h = c.render(width).length;
            if ((c as unknown) === (history as unknown)) {
                before = total;
                historyHeight = h;
            }
            total += h;
        }
        if (historyHeight < 0) return false;
        const contentLine = row - 1 + Math.max(0, total - tui.terminal.rows);
        const local = contentLine - before;
        if (local < 0 || local >= historyHeight) return false;
        return history.clickAtLocalLine(local);
    };

    /** grok's scrollback focus: Tab (on an empty prompt) hands the keyboard to
     * the transcript — arrows walk entries, Left/Right fold, letters bounce
     * straight back to the prompt and type. */
    const handleScrollbackFocus = (data: string): { consume: boolean } | undefined => {
        if (isUp(data) || isDown(data) || isCtrlUp(data) || isCtrlDown(data)) {
            if (history.moveSelection(isUp(data) || isCtrlUp(data) ? -1 : 1)) tui.requestRender();
            return { consume: true };
        }
        if (isShiftLeft(data) || isShiftRight(data) || isAltUp(data) || isAltDown(data)) {
            if (history.jumpTurn(isShiftLeft(data) || isAltUp(data) ? -1 : 1)) tui.requestRender();
            return { consume: true };
        }
        if (isLeft(data) || isRight(data)) {
            if (history.setSelectedExpanded(isRight(data))) tui.requestRender();
            return { consume: true };
        }
        if (isEnter(data)) {
            if (history.toggleSelected()) tui.requestRender();
            return { consume: true };
        }
        // Window scrolling without moving the selection (grok's scroll keys).
        if (isPageUp(data) || isPageDown(data)) {
            history.scrollViewportLines(isPageUp(data) ? -history.viewportPage() : history.viewportPage());
            tui.requestRender();
            return { consume: true };
        }
        if (isCtrlD(data) || data === "\x15" /* ctrl+u */) {
            history.scrollViewportLines(
                isCtrlD(data) ? Math.ceil(history.viewportPage() / 2) : -Math.ceil(history.viewportPage() / 2),
            );
            tui.requestRender();
            return { consume: true };
        }
        if (isHome(data) || isEnd(data)) {
            history.scrollViewportEdge(isHome(data) ? "top" : "bottom");
            tui.requestRender();
            return { consume: true };
        }
        // Mouse wheel: coalesced (see queueWheel) — 2 lines per net event,
        // one-page cap per window, direction jitter cancels to zero.
        const wheel = countWheelScroll(data);
        if (wheel !== 0) {
            queueWheel(wheel);
            return { consume: true };
        }
        // Left-click selects the entry under the pointer (button 0 press; no
        // wheel/motion bits — modifier bits are fine).
        const click = /^\x1b\[<(\d+);(\d+);(\d+)M/.exec(data);
        if (click) {
            const button = Number(click[1]);
            if ((button & 0b1100011) === 0 && selectAtScreenRow(Number(click[3]))) tui.requestRender();
            return { consume: true };
        }
        if (MOUSE_SGR_ANY.test(data)) return { consume: true };
        // e: expand/collapse everything (the viewport re-anchors on the
        // selection, so this never flings the screen to the bottom).
        if (data === "e") {
            history.toggleToolsExpanded();
            tui.requestRender();
            return { consume: true };
        }
        if (data === "y") {
            copySelected();
            return { consume: true };
        }
        if (isEsc(data) || isCtrlE(data) || isTab(data) || data === " " || data === "q") {
            exitScrollbackFocus();
            return { consume: true };
        }
        // Any other printable key: back to the prompt, and let the editor
        // receive this very keystroke (grok's letter-key auto-focus).
        if (isPrintableChar(data) || BRACKETED_PASTE.test(data)) {
            exitScrollbackFocus();
            return undefined;
        }
        // Remaining control chords (ctrl+c quit, shift+tab agent cycle, …)
        // fall through to the normal handlers below.
        return undefined;
    };

    return (data) => {
        // Trace raw input: shows the press/release pair, modifiers, and which
        // chord (if any) a keystroke resolves to — the view that exposes
        // double-fire / event-ordering bugs.
        traceEvent(
            "input",
            `${JSON.stringify(data)} release=${isKeyRelease(data)} esc=${isEsc(data)} busy=${state.busy} q=${queuedMessages.length}`,
        );

        // Under the Kitty keyboard protocol a single physical keypress emits BOTH
        // a press and a release event, and our chord matchers (isEsc, isCtrlC, …)
        // match the codepoint regardless of event type. The TUI filters releases
        // before the focused component, but input listeners run earlier, so a
        // lone Esc would fire the interrupt twice — the release firing lands on
        // the *next* (drained) turn and kills it. Drop releases here; every chord
        // below is a press-only action. (isKeyRelease excludes bracketed-paste.)
        if (isKeyRelease(data)) return undefined;

        // Selectors (e.g. /tree) own ctrl-key chords like ctrl+l/ctrl+d while
        // focused — global shortcuts that would shadow them only fire when the
        // editor has focus.
        const editorFocused = (editor as unknown as { focused?: boolean }).focused === true;

        // Scrollback focus mode owns navigation keys while active. Selectors
        // (which steal editor focus) suspend it implicitly via the flag reset
        // on exit paths below.
        if (state.scrollbackFocus && editorFocused && deps.getSelectorDepth() === 0) {
            const handled = handleScrollbackFocus(data);
            if (handled) return handled;
        } else if (state.scrollbackFocus) {
            // A selector/overlay took over — drop focus mode quietly.
            exitScrollbackFocus();
        }

        // ctrl+up/down (or alt+up/down) enters navigation mode — Tab already
        // has a day job in loop (completion). The same chords keep working
        // inside nav mode, so holding ctrl+up just keeps walking entries.
        if (
            (isCtrlUp(data) || isCtrlDown(data) || isAltUp(data) || isAltDown(data)) &&
            editorFocused &&
            deps.getSelectorDepth() === 0
        ) {
            if (enterScrollbackFocus() && (isAltUp(data) || isAltDown(data))) {
                history.jumpTurn(isAltUp(data) ? -1 : 1);
                tui.requestRender();
            }
            return { consume: true };
        }
        // Drag-and-drop / paste of image file(s) into the prompt: attach them
        // (insert clean [image:…] tokens) instead of pasting the raw path text.
        // Editor-focused only, so it never fires while a selector owns input, and
        // only when the model accepts images — otherwise let the path paste as
        // plain text rather than swallowing it into an attachment it can't use.
        if (editorFocused && modelAcceptsImages(state.modelId)) {
            const dropped = droppedImagePaths(data, state.cwd);
            if (dropped) {
                for (const path of dropped) void ctx.attachImage(path);
                return { consume: true };
            }
        }
        // Agent cycling: Shift+Tab only. Plain Tab is reserved for the editor's
        // completion — slash-command autocomplete and "@" file completion — so
        // we never consume it here; it falls through to the focused editor,
        // which triggers/applies the completion. Cycle = active custom agent (if
        // selected via /agents) plus all built-ins.
        const wantsAgentCycle = isShiftTab(data);
        if (wantsAgentCycle && editorFocused) {
            // Cycle = visible built-ins, plus the one extra agent the user has
            // opted into (a custom agent or a revealed hidden built-in like
            // data-analyst). Hidden built-ins stay out until selected.
            const cycle = [
                ...(state.cycleCustomAgent && agentExists(state.cycleCustomAgent) ? [state.cycleCustomAgent] : []),
                ...listAgents()
                    .filter((a) => a.builtin && !a.hidden)
                    .map((a) => a.name),
            ];
            const next = cycle[(cycle.indexOf(state.agent) + 1) % cycle.length];
            state.agent = next;
            settingsStore.set("agent", next);
            statusLine.setAgent(next);
            tui.requestRender();
            return { consume: true };
        }
        if (isCtrlL(data) && editorFocused) {
            ctx.clearScreen();
            return { consume: true };
        }
        // Ctrl+P: cycle through the /scoped-models list. Editor-focused only
        // (selectors own their own chords); skips models that dropped out of
        // the catalog or lost availability since being scoped.
        if (isCtrlP(data) && editorFocused) {
            const scoped = (getSetting("scopedModels") ?? []).filter((id) => getModelSync(id)?.available !== false);
            if (scoped.length === 0) {
                history.addSystem("no scoped models — pick some with /scoped-models");
                tui.requestRender();
                return { consume: true };
            }
            const next = scoped[(scoped.indexOf(state.modelId) + 1) % scoped.length];
            if (next !== state.modelId) void ctx.setModel(next);
            return { consume: true };
        }
        // ctrl+e toggles navigation mode (expand-all moved to `e` inside nav).
        if (isCtrlE(data) && editorFocused && deps.getSelectorDepth() === 0) {
            enterScrollbackFocus();
            return { consume: true };
        }
        if (isCtrlV(data)) {
            const path = readClipboardImageToFile();
            if (path) {
                void ctx.attachImage(path);
                return { consume: true };
            }
        }
        if (isCtrlI(data)) {
            const path = pickImageFile();
            if (path) void ctx.attachImage(path);
            return { consume: true };
        }
        // Ctrl+G: send "continue" as a message — the one-keystroke version of
        // the resume-after-interrupt ritual (reopen session, type "continue").
        // Idle + editor-focused only: while a turn runs it would just queue
        // noise, and selectors own their own ctrl chords.
        if (isCtrlG(data) && !state.busy && editorFocused) {
            if (editor.onSubmit) void editor.onSubmit("continue");
            return { consume: true };
        }
        if (isCtrlD(data) && !state.busy && editorFocused) {
            cleanExit(0);
            return { consume: true };
        }
        if (isCtrlC(data)) {
            if (state.busy) {
                state.abort.abort();
                state.abort = new AbortController();
                state.busy = false;
                hideWorking();
                queuedMessages.length = 0;
                renderPending();
                tui.requestRender();
                return { consume: true };
            }
            const now = Date.now();
            if (now - state.lastCtrlCAt < 1000) {
                cleanExit(130);
                return { consume: true };
            }
            state.lastCtrlCAt = now;
            history.addSystem("Press Ctrl+C again to quit.");
            tui.requestRender();
            return { consume: true };
        }
        // Esc on an idle, EMPTY prompt enters navigation mode (and Esc exits
        // it — a toggle). This is the mac-friendly entry: ctrl+arrows are OS
        // gestures there. With a draft present Esc stays with the editor.
        if (
            isEsc(data) &&
            !state.busy &&
            editorFocused &&
            deps.getSelectorDepth() === 0 &&
            editor.getText() === "" &&
            enterScrollbackFocus()
        ) {
            return { consume: true };
        }
        // Esc with a stray idle selection just drops it (safety net).
        if (isEsc(data) && !state.busy && deps.getSelectorDepth() === 0 && history.clearSelection()) {
            tui.requestRender();
            return { consume: true };
        }
        // Esc aborts the running turn — but not while a selector/prompt owns
        // the input (e.g. the ask tool's question UI, extension api.ui panels):
        // there Esc must reach the focused component (skip/cancel), not kill
        // the whole turn.
        if (isEsc(data) && state.busy && deps.getSelectorDepth() === 0) {
            state.abort.abort();
            state.abort = new AbortController();
            state.busy = false;
            hideWorking();
            tui.requestRender();
            return { consume: true };
        }
        return undefined;
    };
}
