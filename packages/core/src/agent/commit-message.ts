/**
 * Commit messages, written from a diff by a cheap one-shot generateText pass.
 *
 * The desktop app's commit dialog offers "leave the message blank to
 * auto-generate one", and this is what fills it. Same shape as `recap.ts`: a
 * single non-streaming call on the session's own model, no tools, no session —
 * nothing here is persisted, because a commit message is handed straight back
 * to the caller and lives in the commit itself.
 *
 * The diff is the whole input, so it is also the whole cost. A staged diff can
 * be enormous (a vendored dependency, a lockfile, a generated bundle), and
 * paying for 2MB of `package-lock.json` to title one commit is indefensible —
 * hence the per-file trimming below rather than a single blunt `slice`.
 */
import { generateText } from "ai";
import { getModel } from "../providers";
import type { CostTracker } from "./cost";

const COMMIT_MESSAGE_PROMPT = `You write git commit messages for a diff.

Rules:
- A single subject line, imperative mood, no trailing period. Max 72 characters.
- Say what the change does and why it matters, not which files moved.
- No "chore:"/"feat:" prefix unless the diff shows the repo already uses one.
- No quotes, no markdown, no backticks, no body — the subject line only.
- Describe only what is in the diff. Never guess at intent you cannot see.`;

/** Total diff budget. Beyond this the model is paying to read noise. */
const MAX_DIFF_CHARS = 24_000;
/** Per-file budget, so one huge file cannot crowd out all the others. */
const MAX_FILE_CHARS = 4_000;

/**
 * Trim a diff to something worth paying for.
 *
 * Splits on file headers and truncates each file's hunks, so a 40-file change
 * still shows the model all 40 names instead of drowning in the first one. The
 * subject line is what we want, and file coverage matters more for that than
 * hunk depth.
 */
export function trimDiffForPrompt(diff: string): string {
    if (diff.length <= MAX_DIFF_CHARS) return diff;

    // Keep the "diff --git" header attached to the hunks that follow it.
    const files = diff.split(/(?=^diff --git )/m).filter((part) => part !== "");
    const trimmed = files.map((file) =>
        file.length <= MAX_FILE_CHARS ? file : `${file.slice(0, MAX_FILE_CHARS)}\n... (file truncated)\n`,
    );

    const joined = trimmed.join("");
    if (joined.length <= MAX_DIFF_CHARS) return joined;
    return `${joined.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated)\n`;
}

/** Models like to wrap a subject in quotes or dress it up as a bullet. */
export function cleanSubject(raw: string): string {
    const firstLine = raw.trim().split("\n").find((line) => line.trim() !== "") ?? "";
    const withoutBullet = firstLine.replace(/^\s*[-*]\s+/, "").trim();
    const withoutFence = withoutBullet.replace(/^`+|`+$/g, "").trim();
    const unquoted =
        (withoutFence.startsWith('"') && withoutFence.endsWith('"')) ||
        (withoutFence.startsWith("'") && withoutFence.endsWith("'"))
            ? withoutFence.slice(1, -1).trim()
            : withoutFence;
    return unquoted.replace(/\.$/, "").trim();
}

/**
 * Write a commit message for `diff`, or return "" if the model gave nothing
 * usable.
 *
 * Returning "" rather than throwing is deliberate: the caller has a staged
 * commit ready to go, and losing it because a summarizer had a bad day would
 * be a much worse outcome than committing under a fallback subject.
 */
export async function generateCommitMessage(opts: {
    diff: string;
    modelId: string;
    /** Branch name, when it is not the default — often the best hint available. */
    branch?: string | undefined;
    tracker?: CostTracker | undefined;
    cwd?: string | undefined;
    abortSignal?: AbortSignal | undefined;
}): Promise<string> {
    const diff = opts.diff.trim();
    if (!diff) return "";

    const prompt =
        (opts.branch ? `Branch: ${opts.branch}\n\n` : "") +
        `Diff:\n${trimDiffForPrompt(diff)}`;

    const model = await getModel(opts.modelId);
    const result = await generateText({
        model,
        instructions: COMMIT_MESSAGE_PROMPT,
        prompt,
        abortSignal: opts.abortSignal,
    });

    if (opts.tracker && result.usage) {
        opts.tracker.add(opts.modelId, result.usage, {
            cwd: opts.cwd,
            source: "commit-message",
        });
    }

    const subject = cleanSubject(result.text);
    // A model that ignored the 72-char rule still wrote something useful; cut
    // it at a word boundary rather than discarding the whole message.
    if (subject.length <= 72) return subject;
    const cut = subject.slice(0, 72);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
}
