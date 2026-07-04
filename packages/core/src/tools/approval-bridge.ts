/**
 * UI bridge for bash approval prompts (bashApprove setting). Core cannot
 * depend on the CLI's TUI, so the interactive confirm flow is injected here at
 * startup, exactly like the ask tool's bridge. The registry doubles as the
 * availability signal: print mode / RPC never register a bridge, so the
 * bashApprove setting is inert there and commands run unprompted as before.
 */

export interface BashApprovalRequest {
    /** The raw command the model asked to run (pre commandPrefix). */
    command: string;
    /** Working directory the command would run in. */
    cwd: string;
    /** Patterns "always allow" would persist (shown so the choice is informed). */
    patterns: string[];
}

/** once = run this time only · always = run + persist `patterns` · deny = refuse. */
export type BashApprovalDecision = "once" | "always" | "deny";

export interface BashApprovalBridge {
    /**
     * Show the prompt and resolve with the user's decision. Must resolve
     * promptly ("deny") when `signal` aborts, and must always restore the
     * editor UI on exit. Concurrent calls (parallel tool calls) must serialize.
     */
    confirm(req: BashApprovalRequest, opts?: { signal?: AbortSignal }): Promise<BashApprovalDecision>;
}

let bridge: BashApprovalBridge | null = null;

/** CLI (interactive mode only) registers its implementation at startup. */
export function setBashApprovalBridge(b: BashApprovalBridge | null): void {
    bridge = b;
}

export function getBashApprovalBridge(): BashApprovalBridge | null {
    return bridge;
}
