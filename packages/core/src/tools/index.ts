import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createReadTool } from "./read";
import { createSqlTool } from "./sql";
import { createWriteTool } from "./write";

export interface ToolContext {
    cwd: string;
    abortSignal?: AbortSignal;
    shellPath?: string;
    commandPrefix?: string;
    /**
     * Scopes the read-before-edit registry. Concurrent sessions in one
     * process (RPC) must not share read state; absent = one shared slate.
     */
    sessionId?: string;
    /**
     * Force bash into a fail-closed, kernel-enforced read-only sandbox (no
     * writable cwd). Set for read-only agents (e.g. plan) that get bash but no
     * write/edit, so bash physically cannot mutate the filesystem.
     */
    readOnlyFs?: boolean;
}

export function createTools(ctx: ToolContext) {
    return {
        read: createReadTool(ctx),
        write: createWriteTool(ctx),
        edit: createEditTool(ctx),
        bash: createBashTool(ctx),
        ls: createLsTool(ctx),
        grep: createGrepTool(ctx),
        find: createFindTool(ctx),
        // sql is read-only by enforcement (SELECT/WITH/EXPLAIN/SHOW/DESCRIBE), so
        // it lives in the main toolset like any other tool: the default agent
        // gets it automatically, and restricted agents keep it only if their
        // allowlist names it (plan/data-analyst do, via READONLY_TOOLS).
        sql: createSqlTool(ctx),
    };
}

export type ToolSet = ReturnType<typeof createTools>;

/** Stable tool name list — agents reference these for per-agent tool selection. */
export const TOOL_NAMES = ["read", "write", "edit", "bash", "ls", "grep", "find", "sql"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export { clearReadRegistry } from "./utils/read-registry";
// Bash denylist guardrail — types + defaults for the /bashdeny management UI.
export {
    DEFAULT_BASH_DENY,
    denyPattern,
    findDeniedCommand,
    formatDenyRefusal,
    isCommandAllowed,
    suggestAllowPatterns,
    type BashDenyEntry,
} from "./utils/command-deny";
// Bash approval prompt (bashApprove setting): the CLI registers its UI bridge
// at startup; without one the setting is inert (print mode / RPC).
export {
    getBashApprovalBridge,
    setBashApprovalBridge,
    type BashApprovalBridge,
    type BashApprovalDecision,
    type BashApprovalRequest,
} from "./approval-bridge";
// Resolves the bundled/downloaded `fd` & `rg` binaries — also used by the CLI to
// power @-mention fuzzy file search in the editor's autocomplete.
export { ensureTool, getToolPath } from "./utils/tools-manager";
// ask tool: not part of createTools/TOOL_NAMES — conditionally attached in
// runTurn (like task), gated on the askUser setting + a live UI bridge.
export { askInputSchema, createAskTool, formatAskAnswers, type AskToolContext } from "./ask";
// websearch tool: also conditionally attached in runTurn, gated on the
// webSearch setting (default off). No UI bridge — works in print mode too.
export { createWebsearchTool, type WebsearchToolContext } from "./websearch";
// plan tool: conditionally attached in runTurn for agents whose tool list
// names it (the plan builtin does). A substantial delivery stops the turn.
export {
    createPlanTool,
    isDeliveredPlan,
    normalizePlanText,
    PLAN_MIN_CHARS,
    PLAN_TOOL_NAME,
    planDeliveredThisStep,
} from "./plan";
export {
    getAskUserBridge,
    isAskUserAvailable,
    setAskUserBridge,
    type AskAnswer,
    type AskOption,
    type AskQuestion,
    type AskUserBridge,
} from "./ask-bridge";

export {
    createBashTool,
    createEditTool,
    createFindTool,
    createGrepTool,
    createLsTool,
    createReadTool,
    createSqlTool,
    createWriteTool,
};
