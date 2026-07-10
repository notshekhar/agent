import { tool } from "ai";
import { z } from "zod";
import { getAskUserBridge, type AskAnswer, type AskQuestion } from "./ask-bridge";

export interface AskToolContext {
    abortSignal?: AbortSignal;
}

const askOptionSchema = z.object({
    label: z
        .string()
        .min(1)
        .max(60)
        .describe(
            'Short display label for this option (1-5 words, shown in the menu). Append " (Recommended)" to the one option you recommend.',
        ),
    description: z
        .string()
        .max(200)
        .describe("One-line explanation of what choosing this option means — its trade-offs or consequences"),
});

const askQuestionSchema = z.object({
    question: z
        .string()
        .min(1)
        .describe(
            "The complete question to ask the user, ending with a question mark. Be specific and include any context needed to answer it on its own.",
        ),
    header: z
        .string()
        .min(1)
        .max(16)
        .describe("Very short topic label for this question (1-2 words, e.g. 'Auth method')"),
    options: z
        .array(askOptionSchema)
        .min(2)
        .max(4)
        .describe(
            "2-4 distinct, mutually exclusive answer choices, with the recommended one first. A free-text 'Other' choice is added automatically — never include your own catch-all option.",
        ),
    multiSelect: z
        .boolean()
        .optional()
        .describe("Set true only when several options can be combined; the user may then toggle multiple."),
});

export const askInputSchema = z.object({
    questions: z
        .array(askQuestionSchema)
        .min(1)
        .max(4)
        .describe(
            "1-4 questions to ask in a single interaction. Prefer one call with a few questions over many calls.",
        ),
});

/** Format the bridge's answers into the string result the model reads. */
export function formatAskAnswers(questions: AskQuestion[], answers: AskAnswer[]): string {
    if (answers.every((a) => a.declined)) {
        return "The user declined to answer. Proceed with your best judgment.";
    }
    const parts: string[] = ["User answers:"];
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const a = answers[i];
        const suffix = q.multiSelect ? " (multi-select)" : "";
        let line: string;
        if (!a || a.declined) line = "→ (no answer — user skipped this question)";
        else if (a.custom) line = `→ (custom answer) "${a.answers.join("; ")}"`;
        else line = `→ ${a.answers.join(", ")}`;
        if (a?.note && !a.declined) line += `\n→ user note: "${a.note}"`;
        parts.push(`[${q.header}] ${q.question}${suffix}\n${line}`);
    }
    return parts.join("\n\n");
}

export function createAskTool(ctx: AskToolContext) {
    return tool({
        description: `Ask the user 1-4 multiple-choice questions and wait for their answers.

WHEN to ask: only when you are blocked on a decision that is genuinely the user's to make — one you cannot resolve from their request, the code, or a sensible default. Good uses: choosing between implementation approaches with real trade-offs, confirming a scope change or destructive/irreversible step, or picking product/UX behavior the user would care about. Do NOT ask about facts you can verify yourself (read the code instead), decisions with an obvious conventional default (pick it and mention your choice in your reply), or permission to proceed with work the user already requested. Reserve it for questions whose answer changes what you do next.

HOW to ask: phrase each question as one complete, specific sentence ending in a question mark, including any context needed to answer it without re-reading the conversation. Give 2-4 distinct, mutually exclusive options with concise labels (1-5 words) and descriptions that state the trade-offs or consequences of each choice. ALWAYS make a recommendation: put the option you recommend FIRST and append " (Recommended)" to its label. Each question automatically shows an "Other" free-text entry, so never add your own "Other"/"Something else" catch-all. Set multiSelect true only when several options can sensibly be combined, and phrase the question accordingly. Prefer one call with a few questions over several calls. The user may leave individual questions unanswered, dismiss the whole prompt (Esc), or attach a short free-text note to a picked option — treat a note as a clarification of that choice. For unanswered questions proceed using your best judgment.`,
        inputSchema: askInputSchema,
        execute: async ({ questions }, options) => {
            const signal = options?.abortSignal ?? ctx.abortSignal;
            if (signal?.aborted) throw new Error("Operation aborted");

            const bridge = getAskUserBridge();
            // Defensive: runTurn only includes the tool when a bridge exists.
            if (!bridge) {
                return "The ask tool is not available in this session (no interactive UI). Proceed without asking.";
            }
            const answers = await bridge.ask(questions, { signal });
            if (signal?.aborted) throw new Error("Operation aborted");
            return formatAskAnswers(questions, answers);
        },
    });
}
