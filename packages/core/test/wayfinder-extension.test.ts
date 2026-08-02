import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import wayfinder from "../src/extensions/builtin/wayfinder/index";
import {
    buildInvocation,
    DEFAULT_TRACKER,
    normalizeTracker,
    resolveTracker,
    TRACKERS,
} from "../src/extensions/builtin/wayfinder/instructions";
import { WAYFINDER_SKILL } from "../src/extensions/builtin/wayfinder/skill-text";
import { getBuiltin } from "../src/extensions/builtin";
import type { ExtensionAPI } from "../src/extensions/api";
import type { SlashCommand } from "../src/commands";

// The skill block the command emits must survive the CLI's parseSkillBlock —
// copied here rather than imported, because core can't depend on the CLI.
const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** Minimal api double: captures the command and the settings bag. */
function activate(settings: Record<string, unknown> = {}) {
    let command: SlashCommand | undefined;
    const api = {
        extension: { setStatus: () => {} },
        settings: {
            getOwn: (key: string, fallback?: unknown) => settings[key] ?? fallback,
            setOwn: (key: string, value: unknown) => {
                settings[key] = value;
            },
        },
        commands: {
            register: (cmd: SlashCommand) => {
                command = cmd;
            },
        },
    } as unknown as ExtensionAPI;
    wayfinder.activate(api);
    return { command: command!, settings };
}

/** Runs the command and returns what it emitted. */
function run(command: SlashCommand, args: string, cwd = process.cwd()) {
    const events: { event: string; data: string }[] = [];
    const ctx = { emit: (event: string, data?: unknown) => events.push({ event, data: String(data ?? "") }), cwd };
    command.handler(ctx as never, args);
    return events;
}

describe("wayfinder — the embedded skill", () => {
    test("is the verbatim upstream SKILL.md, frontmatter included", () => {
        expect(WAYFINDER_SKILL).toStartWith("---\nname: wayfinder\n");
        // disable-model-invocation is why this is a command and not a persona.
        expect(WAYFINDER_SKILL).toContain("disable-model-invocation: true");
        expect(WAYFINDER_SKILL).toContain("## The Map");
        expect(WAYFINDER_SKILL).toContain("## Fog of war");
    });

    test("the invocation parses as a skill block, with the frontmatter stripped", () => {
        const match = buildInvocation("markdown", "").match(SKILL_BLOCK_RE);
        expect(match).not.toBeNull();
        expect(match![1]).toBe("wayfinder");
        expect(match![2]).not.toBe("");
        expect(match![3]).not.toContain("disable-model-invocation");
        expect(match![3]).toContain("## The Map");
        expect(match![4]).toBeUndefined();
    });

    test("args ride after the block as the user's message", () => {
        const match = buildInvocation("github", "port the billing engine to events").match(SKILL_BLOCK_RE);
        expect(match![4]).toBe("port the billing engine to events");
    });

    test("each tracker contributes its own operations section, and only its own", () => {
        const github = buildInvocation("github", "");
        const markdown = buildInvocation("markdown", "");
        expect(github).toContain("Wayfinding operations (GitHub");
        expect(github).not.toContain("Wayfinding operations (local markdown)");
        expect(github).toContain("gh issue create");
        expect(markdown).toContain("Wayfinding operations (local markdown)");
        expect(markdown).not.toContain("Wayfinding operations (GitHub");
        expect(markdown).toContain(".wayfinder/");
        // Both substitute the sibling skills loop doesn't ship.
        for (const text of [github, markdown]) expect(text).toContain("## Running this in loop");
    });
});

describe("wayfinder — the command", () => {
    test("is registered as /wayfinder and submits a turn", () => {
        const { command } = activate();
        expect(command.name).toBe("wayfinder");
        const events = run(command, "a loose idea");
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("inject-skill");
        expect(events[0].data).toContain('<skill name="wayfinder"');
        expect(events[0].data).toEndWith("a loose idea");
    });

    test("`tracker <mode>` persists the choice instead of invoking the skill", () => {
        const { command, settings } = activate();
        const events = run(command, "tracker markdown");
        expect(settings.tracker).toBe("markdown");
        expect(events[0].event).toBe("help");
        expect(events.some((e) => e.event === "inject-skill")).toBe(false);
    });

    test("bare `tracker` reports without changing anything", () => {
        const { command, settings } = activate({ tracker: "github" });
        const events = run(command, "tracker");
        expect(settings.tracker).toBe("github");
        expect(events[0].data).toContain("github");
    });

    test("an unknown tracker is rejected, not silently stored", () => {
        const { command, settings } = activate();
        const events = run(command, "tracker jira");
        expect(events[0].event).toBe("error");
        expect(settings.tracker).toBeUndefined();
    });

    test("a normal idea starting with the word tracker still invokes the skill", () => {
        const { command } = activate();
        const events = run(command, "tracker rewrite: move issues off Linear");
        expect(events[0].event).toBe("inject-skill");
    });

    test("the stored tracker picks the operations section", () => {
        const { command } = activate({ tracker: "github" });
        expect(run(command, "chart it")[0].data).toContain("Wayfinding operations (GitHub");
    });
});

describe("wayfinder — tracker resolution", () => {
    test("an explicit tracker is returned as-is", () => {
        expect(resolveTracker("github", process.cwd())).toBe("github");
        expect(resolveTracker("markdown", process.cwd())).toBe("markdown");
    });

    test("auto falls back to markdown outside a GitHub repo", () => {
        expect(resolveTracker("auto", mkdtempSync(`${tmpdir()}/wayfinder-`))).toBe("markdown");
    });

    test("normalizeTracker accepts the modes and rejects the rest", () => {
        for (const t of TRACKERS) expect(normalizeTracker(t.toUpperCase())).toBe(t);
        expect(normalizeTracker("linear")).toBeNull();
        expect(normalizeTracker(undefined)).toBeNull();
        expect(TRACKERS).toContain(DEFAULT_TRACKER);
    });
});

describe("wayfinder — registration", () => {
    test("ships as an opt-in builtin", () => {
        const builtin = getBuiltin("wayfinder");
        expect(builtin).toBeDefined();
        expect(builtin!.defaultEnabled).toBe(false);
        expect(builtin!.module).toBe(wayfinder);
    });
});
