import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { hookBus, matcherTest, runHooks, type HookPayload } from "../src/agent/hooks";

describe("matcherTest", () => {
    test("empty or * matches everything", () => {
        expect(matcherTest(undefined, "bash")).toBe(true);
        expect(matcherTest("", "bash")).toBe(true);
        expect(matcherTest("*", "bash")).toBe(true);
    });

    test("exact name and | lists", () => {
        expect(matcherTest("bash", "bash")).toBe(true);
        expect(matcherTest("bash", "read")).toBe(false);
        expect(matcherTest("read|write|edit", "write")).toBe(true);
        expect(matcherTest("read|write|edit", "bash")).toBe(false);
    });

    test("regex matchers", () => {
        expect(matcherTest("ba.*", "bash")).toBe(true);
        expect(matcherTest("^(read|grep)$", "grep")).toBe(true);
        expect(matcherTest("^(read|grep)$", "bash")).toBe(false);
    });

    test("invalid regex never throws, never matches", () => {
        expect(matcherTest("([", "bash")).toBe(false);
    });

    test("events without a matcher target match any group", () => {
        expect(matcherTest("whatever", undefined)).toBe(true);
    });
});

describe("hook event observation", () => {
    /** In-process watchers (the cmux reporter) are the reason this exists:
     * they need every lifecycle event, and the machine they run on has no
     * hook commands configured — the case runHooks returns from first. */
    test("every dispatched event reaches the bus, hooks configured or not", async () => {
        const dir = mkdtempSync(`${tmpdir()}/hookbus-`);
        const seen: HookPayload[] = [];
        const listener = (p: HookPayload) => seen.push(p);
        hookBus.on("event", listener);
        try {
            await runHooks("Stop", undefined, { session_id: "s1", last_assistant_message: "done" }, dir);
            await runHooks("PreToolUse", "bash", { session_id: "s1", tool_name: "bash" }, dir);
        } finally {
            hookBus.off("event", listener);
            rmSync(dir, { recursive: true, force: true });
        }

        expect(seen.map((p) => p.hook_event_name)).toEqual(["Stop", "PreToolUse"]);
        // The payload is the full one a hook command would get on stdin.
        expect(seen[0]).toMatchObject({ cwd: dir, session_id: "s1", last_assistant_message: "done" });
        expect(seen[1]).toMatchObject({ tool_name: "bash" });
    });

    test("a throwing watcher cannot break the dispatch", async () => {
        const dir = mkdtempSync(`${tmpdir()}/hookbus-`);
        const boom = () => {
            throw new Error("watcher bug");
        };
        hookBus.on("event", boom);
        try {
            const outcome = await runHooks("Stop", undefined, { session_id: "s1" }, dir);
            expect(outcome.block).toBe(false);
            expect(outcome.messages).toEqual([]);
        } finally {
            hookBus.off("event", boom);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
