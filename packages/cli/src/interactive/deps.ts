import type { Container, Editor, SelectItem, SelectList, TUI } from "@notshekhar/loop-tui";
import type { CommandRegistry, CostTracker, Session, SessionManager, UsageBlock } from "@notshekhar/loop-core";
import type { ChatHistory } from "./components/chat-history";
import type { StatusLine } from "./components/status-line";
import type { TodoPanel } from "./components/todo-panel";

/**
 * Stable references for handlers. Functions and objects here don't change
 * across the app's lifetime — only the AppState fields mutate.
 */
export interface AppDeps {
    tui: TUI;
    history: ChatHistory;
    statusLine: StatusLine;
    /** Pinned checklist the todo tool maintains (below the loader, above the editor). */
    todoPanel: TodoPanel;
    tracker: CostTracker;
    editor: Editor;
    commands: CommandRegistry;
    manager: SessionManager;
    queuedMessages: string[];
    refreshStatusLine: (usage?: UsageBlock) => void;
    refreshStatusLineCtx: (usage?: UsageBlock) => void;
    renderPending: () => void;
    showWorking: (msg?: string) => void;
    hideWorking: () => void;
    showSelector: (component: Container, focusable: Container | SelectList) => () => void;
    /** Open-selector count — >0 means a menu/prompt owns the input right now. */
    getSelectorDepth: () => number;
    selectOnce: (items: SelectItem[], title?: string, opts?: { initialIndex?: number }) => Promise<SelectItem | null>;
    /** Single-select with a type-to-filter search box (long lists). */
    searchOnce: (items: SelectItem[], title?: string, opts?: { initialIndex?: number }) => Promise<SelectItem | null>;
    /** Multi-select toggle list (Enter/Space toggles, done confirms, Esc → null). */
    toggleOnce: (values: string[], initial: Set<string>, title?: string) => Promise<string[] | null>;
    promptOnce: (label?: string, initial?: string) => Promise<string>;
    resolveModelId: (input: string) => Promise<string | null>;
    /** Rebuild slash-command autocomplete after runtime command changes (agent create/delete). */
    refreshCommands: () => void;
    ensureSession: () => Promise<Session>;
    cleanExit: (code?: number) => void;
    /** App version (undefined in dev runs). */
    version?: string;
    /** Undo the console→chat bridge before handing the terminal to a child process. */
    restoreConsole: () => void;
    /** Start/stop the shared 1s ticker after clock/timer/reminder changes. */
    syncTicker: () => void;
}
