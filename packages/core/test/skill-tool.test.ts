import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSkillsForPrompt, type Skill } from "../src/agent/skills";
import { createSkillTool, stripSkillFrontmatter } from "../src/tools/skill";

let dir: string;
let skills: Skill[];

const SKILL_BODY = "# Review\n\nRun the checks in scripts/check.sh before approving.";

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-tool-"));
    mkdirSync(join(dir, "review"));
    writeFileSync(
        join(dir, "review", "SKILL.md"),
        `---\nname: review\ndescription: Review a change\n---\n${SKILL_BODY}\n`,
    );
    skills = [
        {
            name: "review",
            description: "Review a change",
            filePath: join(dir, "review", "SKILL.md"),
            baseDir: join(dir, "review"),
            disableModelInvocation: false,
        },
        {
            name: "deploy",
            description: "Deploy the app",
            filePath: join(dir, "deploy.md"),
            baseDir: dir,
            disableModelInvocation: false,
        },
    ];
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function invoke(name: string): Promise<string> {
    const tool = createSkillTool({ skills });
    // biome-ignore lint/suspicious/noExplicitAny: AI-SDK execute signature
    return await (tool as any).execute({ name }, {});
}

describe("createSkillTool", () => {
    test("loads content with frontmatter stripped and a baseDir note", async () => {
        const out = await invoke("review");
        expect(out).toContain(`Skill "review"`);
        expect(out).toContain(SKILL_BODY);
        expect(out).toContain(join(dir, "review"));
        expect(out).not.toContain("description: Review a change");
    });

    test("unknown name fails soft and lists what exists", async () => {
        const out = await invoke("revew");
        expect(out).toContain(`[unknown skill "revew"`);
        expect(out).toContain("review");
        expect(out).toContain("deploy");
    });

    test("unreadable file fails soft with the error", async () => {
        // deploy.md was never written — read fails, tool must not throw.
        const out = await invoke("deploy");
        expect(out).toContain(`[failed reading skill "deploy"`);
    });

    test("empty skill list reports (none)", async () => {
        const tool = createSkillTool({ skills: [] });
        // biome-ignore lint/suspicious/noExplicitAny: AI-SDK execute signature
        const out = await (tool as any).execute({ name: "review" }, {});
        expect(out).toContain("(none)");
    });
});

describe("stripSkillFrontmatter", () => {
    test("removes a leading frontmatter block only", () => {
        expect(stripSkillFrontmatter("---\na: b\n---\nBody")).toBe("Body");
        expect(stripSkillFrontmatter("Body with --- inside")).toBe("Body with --- inside");
    });
});

describe("formatSkillsForPrompt viaTool wording", () => {
    test("default wording points at the read tool", () => {
        const block = formatSkillsForPrompt(skills);
        expect(block).toContain("Use the read tool");
        expect(block).not.toContain("skill tool");
    });

    test("viaTool wording points at the skill tool but keeps <location> as fallback", () => {
        const block = formatSkillsForPrompt(skills, { viaTool: true });
        expect(block).toContain("Invoke the skill tool");
        expect(block).not.toContain("Use the read tool");
        expect(block).toContain("<location>");
    });

    test("disable-model-invocation skills stay hidden in both wordings", () => {
        const hidden = [...skills, { ...skills[0], name: "secret", disableModelInvocation: true }];
        for (const viaTool of [false, true]) {
            const block = formatSkillsForPrompt(hidden, { viaTool });
            expect(block).not.toContain("secret");
        }
    });
});
