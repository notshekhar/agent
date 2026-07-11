/**
 * skill: explicit skill invocation — the model loads a skill's full
 * instructions by name instead of read-ing its file path. Conditionally
 * attached in runTurn whenever the turn has visible skills (same `skills`
 * setting + trust gate as the prompt listing; no setting of its own), AFTER
 * the task tool so subagents never inherit it — they keep the read-tool
 * fallback wording in their skills prompt. The read path keeps working even
 * when this tool is attached; the tool is the preferred, observable route
 * (one-line UI summary, hookable, trackable) rather than a new capability.
 *
 * Content is read fresh at call time (like the /skill:name command), so
 * editing a skill mid-session takes effect on the next invocation.
 */
import { tool } from "ai";
import { z } from "zod";
import { readFileSync } from "node:fs";
// Type-only: erased at runtime, so tools/ gains no runtime edge into agent/
// (agent/skills pulls in the extension host — a cycle if imported for value).
import type { Skill } from "../agent/skills";

export const SKILL_TOOL_NAME = "skill";

export interface SkillToolContext {
    /** Visible (model-invocable) skills for this turn — caller pre-filters
     * disable-model-invocation entries, same set the prompt block lists. */
    skills: Skill[];
}

/** Strip a leading `--- … ---` frontmatter block — same regex the /skill:name
 * command uses, so both invocation paths deliver identical content. */
export function stripSkillFrontmatter(content: string): string {
    return content.replace(/^---[\s\S]*?---\s*\n/, "").trim();
}

export function createSkillTool(ctx: SkillToolContext) {
    return tool({
        description:
            "Load a skill's full instructions. Skills are listed in <available_skills> in your context; " +
            "invoke one by name when the current task matches its description, then follow the returned instructions.",
        inputSchema: z.object({
            name: z.string().min(1).describe("Skill name, exactly as listed in <available_skills>"),
        }),
        // Failures return readable text instead of throwing (websearch-style):
        // a hallucinated name gets the real list back, which is the best
        // possible correction prompt.
        execute: async ({ name }) => {
            const skill = ctx.skills.find((s) => s.name === name);
            if (!skill) {
                const available = ctx.skills.map((s) => s.name).join(", ");
                return `[unknown skill "${name}" — available: ${available || "(none)"}]`;
            }
            let content: string;
            try {
                content = stripSkillFrontmatter(readFileSync(skill.filePath, "utf8"));
            } catch (err) {
                return `[failed reading skill "${name}": ${err instanceof Error ? err.message : String(err)}]`;
            }
            return `Skill "${skill.name}" (from ${skill.filePath}).\nRelative paths in these instructions resolve against ${skill.baseDir} — use absolute paths in tool commands.\n\n${content}`;
        },
    });
}
