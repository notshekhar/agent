/**
 * UI bridge for the ask tool. Core cannot depend on the CLI's TUI, so the
 * interactive question flow is injected here at startup (mirrors the extension
 * host's setServices pattern). The registry doubles as the availability
 * signal: print mode / RPC never register a bridge, so runTurn simply never
 * includes the ask tool there.
 */

/** One selectable option for an ask question. */
export interface AskOption {
    label: string;
    description: string;
}

/** One question posed to the user. */
export interface AskQuestion {
    question: string;
    header: string;
    options: AskOption[];
    multiSelect?: boolean;
}

/** The user's answer to one question (index-aligned with the questions array). */
export interface AskAnswer {
    /** Chosen option label(s), or the free-typed text when `custom` is true. */
    answers: string[];
    /** Answer came from the automatic "Other" free-text entry. */
    custom?: boolean;
    /** User pressed Esc — this and all following questions were skipped. */
    declined?: boolean;
}

export interface AskUserBridge {
    /**
     * Show the questions one at a time and resolve with index-aligned answers.
     * Must resolve promptly (remaining answers declined) when `signal` aborts,
     * and must always restore the editor UI on exit.
     */
    ask(questions: AskQuestion[], opts?: { signal?: AbortSignal }): Promise<AskAnswer[]>;
}

let bridge: AskUserBridge | null = null;

/** CLI (interactive mode only) registers its implementation at startup. */
export function setAskUserBridge(b: AskUserBridge | null): void {
    bridge = b;
}

export function getAskUserBridge(): AskUserBridge | null {
    return bridge;
}

/** Availability signal — gates ask-tool inclusion in runTurn. */
export function isAskUserAvailable(): boolean {
    return bridge !== null;
}
