/**
 * Session titles — a short name for what this session is about, generated
 * from the first exchange.
 *
 * A session's identity is otherwise a ULID and a cwd, which is fine while you
 * are looking at it and useless the moment you are not: a sidebar of panes, a
 * notification on a phone, `loop sessions` a week later. The title is what
 * makes one session tellable from another, so it is generated once, early
 * (the first turn is what the session is about), and never overwrites a name
 * the user chose themselves.
 *
 * Generated with the session's OWN model rather than a fixed cheap one. loop
 * has no house provider to fall back on — whichever model the user configured
 * is the only one guaranteed to be reachable and paid for — and this is one
 * short, tool-free call against a prompt whose whole job is to be brief.
 */
import { generateText } from "ai";
import { getModel } from "../providers";
import type { CostTracker } from "./cost";
import { isAbortError } from "./abort";

/** Titles are chips in someone else's UI: past this they are just elided. */
const MAX_TITLE_CHARS = 48;
/** Enough of the exchange to know the subject; not enough to cost anything. */
const MAX_INPUT_CHARS = 2_000;

const TITLE_PROMPT = `Write a title for this coding session: what the user is trying to get done.

Rules:
- At most 6 words. Shorter is better.
- Start with a verb in plain form ("Fix", "Add", "Debug", "Refactor").
- Name the specific thing worked on — a file, feature, or symbol — not the
  activity in general. "Fix flaky pty test" beats "Fix a test".
- No quotes, no trailing period, no markdown, no preamble.
- Same language as the user's message.

Reply with the title alone.`;

/** One line, no punctuation-noise, short enough for a tab. */
export function cleanTitle(raw: string): string {
    const line =
        raw
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? "";
    const stripped = line
        .replace(/^["'`*#\s]+|["'`*\s]+$/g, "") // quoting/markdown a model added anyway
        .replace(/\.$/, "")
        .replace(/\s+/g, " ")
        .trim();
    if (stripped.length <= MAX_TITLE_CHARS) return stripped;
    // Cut at a word boundary so the elision reads as a title, not a truncation.
    const cut = stripped.slice(0, MAX_TITLE_CHARS);
    const lastSpace = cut.lastIndexOf(" ");
    return `${(lastSpace > MAX_TITLE_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * A title for the session, or null when there isn't one worth showing.
 *
 * Best-effort by construction: the caller is a turn that has already
 * finished, so a provider hiccup here must cost nothing and say nothing —
 * every failure path returns null and the session keeps the name it had.
 */
export async function generateSessionTitle(opts: {
    /** What the user opened the session with. */
    userInput: string;
    /** What the agent replied — disambiguates a terse opening prompt. */
    assistantText?: string;
    /** The session's own model. */
    modelId: string;
    abortSignal?: AbortSignal;
    tracker?: CostTracker;
    sessionPub?: string;
    cwd?: string;
}): Promise<string | null> {
    const user = opts.userInput.trim();
    if (!user) return null;

    const exchange = [
        `User: ${user.slice(0, MAX_INPUT_CHARS)}`,
        opts.assistantText?.trim() ? `Assistant: ${opts.assistantText.trim().slice(0, 500)}` : "",
    ]
        .filter(Boolean)
        .join("\n\n");

    try {
        const model = await getModel(opts.modelId);
        const result = await generateText({
            model,
            prompt: `<exchange>\n${exchange}\n</exchange>\n\n${TITLE_PROMPT}`,
            abortSignal: opts.abortSignal,
        });
        if (opts.tracker && result.usage) {
            opts.tracker.add(opts.modelId, result.usage, {
                cwd: opts.cwd,
                sessionPub: opts.sessionPub,
                source: "session-title",
            });
        }
        const title = cleanTitle(result.text ?? "");
        // A one-word answer is the model failing to understand the task, and a
        // title is not worth a retry — the fallback (no title) is honest.
        return title.length > 2 && title.includes(" ") ? title : null;
    } catch (err) {
        if (isAbortError(err) || opts.abortSignal?.aborted) return null;
        return null;
    }
}
