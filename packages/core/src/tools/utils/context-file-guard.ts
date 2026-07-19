/**
 * Workspace context-file protection — a guardrail against the agent deleting
 * AGENTS.md / CLAUDE.md. These files feed the system prompt every turn, so
 * losing one silently changes how the agent behaves in the repo; a model doing
 * "cleanup" (or migrating CLAUDE.md → AGENTS.md via mv) must not remove them
 * on its own. Same philosophy as the denylist: stops an honest model, not a
 * determined bypass — the OS sandbox is the jail.
 *
 * The guard matches deleting/moving commands (rm, unlink, shred, trash, mv,
 * git rm, git mv) whose arguments name a context file, per segment via the
 * denylist's own parser. An explicit whole-command allow rule in the user's
 * permissions config skips it; interactively it prompts instead of refusing.
 */
import { resolveSegment, splitSegments } from "./command-deny";

/** Basenames the workspace-context loader reads (agent/context.ts). Compared
 * case-insensitively — the common dev filesystems are case-insensitive. */
const PROTECTED_BASENAMES = new Set(["agents.md", "claude.md"]);

/** Commands that remove or relocate their file arguments. */
const DELETING_COMMANDS = new Set(["rm", "unlink", "shred", "srm", "trash", "mv"]);

export interface ContextFileHit {
    /** The resolved deleting command ("rm", "git rm", …). */
    command: string;
    /** The protected basename it targets. */
    file: string;
}

/**
 * Return the first segment that would delete or move a workspace context
 * file, or null. Arguments arrive basename-normalized from resolveSegment,
 * so `rm docs/CLAUDE.md` and `rm CLAUDE.md` both match.
 */
export function findContextFileDeletion(command: string): ContextFileHit | null {
    for (const segment of splitSegments(command)) {
        const resolved = resolveSegment(segment);
        if (!resolved) continue;
        let name = resolved.command;
        let args = resolved.rest;
        if (name === "git" && (args[0] === "rm" || args[0] === "mv")) {
            name = `git ${args[0]}`;
            args = args.slice(1);
        } else if (!DELETING_COMMANDS.has(name)) {
            continue;
        }
        const file = args.find((arg) => !arg.startsWith("-") && PROTECTED_BASENAMES.has(arg.toLowerCase()));
        if (file) return { command: name, file };
    }
    return null;
}

/** Refusal shown when no interactive approval is possible (print mode / RPC). */
export function formatContextFileRefusal(hit: ContextFileHit): string {
    return (
        `Refused: \`${hit.command}\` targets ${hit.file}, a workspace context file loaded into the system prompt. ` +
        `Do not delete or move it on your own. If the user explicitly asked for this, tell them to run the command ` +
        `themselves or add an allow permission rule for it; otherwise continue without removing the file.`
    );
}
