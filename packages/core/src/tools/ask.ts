import { tool } from "ai";
import { z } from "zod";
import { getAskUserBridge, type AskAnswer, type AskQuestion } from "./ask-bridge";

export interface AskToolContext {
    abortSignal?: AbortSignal;
}

const askOptionSchema = z.object({
    label: z.string().min(1).max(60).describe("Short display label for this option (a few words, shown in the menu)"),
    description: z.string().max(200).describe("One-line explanation of what choosing this option means"),
});

const askQuestionSchema = z.object({
    question: z
        .string()
        .min(1)
        .describe("The complete question to ask the user. Be specific and include any context needed to answer."),
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
            "2-4 mutually distinct answer choices. A free-text 'Other' choice is added automatically — never include your own catch-all option.",
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
        parts.push(`[${q.header}] ${q.question}${suffix}\n${line}`);
    }
    return parts.join("\n\n");
}

export function createAskTool(ctx: AskToolContext) {
    return tool({
        description: `Ask the user 1-4 multiple-choice questions and wait for their answers. Use this when you need a decision or preference you cannot infer yourself — choosing between implementation approaches, confirming scope or trade-offs, or picking between valid alternatives. Do NOT use it for anything you can answer by reading the code, and do not use it to ask for permission to proceed with normal work. Each question shows its options plus an automatic "Other" entry where the user can type a custom answer, so never add your own "Other"/"Something else" option. Options should be distinct and self-explanatory; put the recommended choice first. Set multiSelect true only when combinations make sense. The user may decline to answer (Esc) — in that case proceed using your best judgment.`,
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
