import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
    setBashApprovalBridge,
    type BashApprovalDecision,
    type BashApprovalRequest,
} from "../src/tools/approval-bridge";

// In-memory settings so the gate never reads/writes the real
// ~/.loop/settings.json (same pattern as alias.test.ts — whose process-global
// mock would otherwise shadow real settings here anyway when the whole suite
// runs).
const mem: Record<string, unknown> = {};
mock.module("../src/settings", () => ({
    getSetting: (k: string) => mem[k],
    setSetting: (k: string, v: unknown) => {
        mem[k] = v;
    },
}));

const { createBashTool } = await import("../src/tools/bash");
const { clearPermissionRulesCache } = await import("../src/tools/utils/permission-rules");
const { getProjectBashAllow } = await import("../src/sessions/projects");
const { canonicalProjectDir } = await import("../src/agent/trust");
const { useTempSessionDb } = await import("./helpers/temp-db");

// "always allow" now persists per-project (projects table), so the tool
// touches the session DB — isolate it per test.
useTempSessionDb();

beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k];
    clearPermissionRulesCache();
    setBashApprovalBridge(null);
});

/** Fake bridge that records requests and replays scripted decisions. */
function fakeBridge(decisions: BashApprovalDecision[]) {
    const requests: BashApprovalRequest[] = [];
    setBashApprovalBridge({
        confirm: (req) => {
            requests.push(req);
            return Promise.resolve(decisions[requests.length - 1] ?? "deny");
        },
    });
    return requests;
}

const run = (command: string) => {
    const bash = createBashTool({ cwd: process.cwd() });
    return (bash as unknown as { execute: (input: object, options: object) => Promise<string> }).execute(
        { command },
        { toolCallId: "t1", messages: [] },
    );
};

describe("bash approval gate (bashApprove setting)", () => {
    test("off by default: bridge is never consulted", async () => {
        const requests = fakeBridge(["deny"]);
        const out = await run("echo unprompted");
        expect(out).toContain("unprompted");
        expect(requests.length).toBe(0);
    });

    test("on + no bridge registered (print mode): runs unprompted", async () => {
        mem.bashApprove = true;
        const out = await run("echo printmode");
        expect(out).toContain("printmode");
    });

    test("allow once: runs but persists nothing", async () => {
        mem.bashApprove = true;
        mem.bashAllow = [];
        const requests = fakeBridge(["once", "once"]);
        expect(await run("echo hi")).toContain("hi");
        expect(mem.bashAllow).toEqual([]);
        // Asked again next time — nothing was remembered.
        await run("echo hi");
        expect(requests.length).toBe(2);
    });

    test("deny: refuses with the user-declined message, command does not run", async () => {
        mem.bashApprove = true;
        fakeBridge(["deny"]);
        expect(run("echo nope")).rejects.toThrow(/declined/);
    });

    test("always: runs, persists the pattern per-project, and skips the next prompt", async () => {
        mem.bashApprove = true;
        const requests = fakeBridge(["always"]);
        expect(await run("echo first")).toContain("first");
        expect(requests.length).toBe(1);
        expect(requests[0].patterns).toEqual(["echo"]);
        // Persisted to the project's grant store, not global settings.
        expect(getProjectBashAllow(canonicalProjectDir(process.cwd()))).toEqual(["echo"]);
        expect(mem.bashAllow).toBeUndefined();
        // Second run matches the remembered grant — no prompt.
        expect(await run("echo second")).toContain("second");
        expect(requests.length).toBe(1);
    });

    test("pre-approved allowlist entry skips the prompt entirely", async () => {
        mem.bashApprove = true;
        mem.bashAllow = ["echo"];
        const requests = fakeBridge(["deny"]);
        expect(await run("echo listed")).toContain("listed");
        expect(requests.length).toBe(0);
    });

    test("compound command with an unlisted segment still prompts", async () => {
        mem.bashApprove = true;
        mem.bashAllow = ["echo"];
        const requests = fakeBridge(["once"]);
        expect(await run("echo a && true")).toContain("a");
        expect(requests.length).toBe(1);
    });

    test("denylist still wins over an allowlisted command", async () => {
        mem.bashApprove = true;
        mem.bashDeny = ["echo"];
        mem.bashAllow = ["echo"];
        const requests = fakeBridge(["once"]);
        expect(run("echo blocked")).rejects.toThrow(/blocked/);
        expect(requests.length).toBe(0);
    });

    test("never: refuses and persists the pattern into bashDeny", async () => {
        mem.bashApprove = true;
        fakeBridge(["never"]);
        expect(run("echo forbidden")).rejects.toThrow(/declined/);
        // Waits a tick so the rejection above has landed before asserting.
        await Bun.sleep(0);
        expect(mem.bashDeny as string[]).toContain("echo");
    });

    test("dangerous command prompts even when a remembered grant covers it", async () => {
        mem.bashApprove = true;
        mem.bashAllow = ["rm"];
        const requests = fakeBridge(["deny"]);
        expect(run("rm -f /nonexistent-loop-test")).rejects.toThrow(/declined/);
        await Bun.sleep(0);
        expect(requests.length).toBe(1);
    });
});

describe("permission rules (settings `permissions`)", () => {
    test("deny rule refuses without any prompt", async () => {
        mem.permissions = { deny: ["Bash(echo *)"] };
        const requests = fakeBridge(["once"]);
        expect(run("echo blocked")).rejects.toThrow(/permission rule/);
        await Bun.sleep(0);
        expect(requests.length).toBe(0);
    });

    test("deny rule catches a hidden segment behind an allowed prefix", async () => {
        mem.permissions = { allow: ["Bash(git *)"], deny: ["Bash(rm *)"] };
        expect(run("git status && rm -rf /tmp/x")).rejects.toThrow(/permission rule/);
    });

    test("ask rule prompts even with bashApprove off", async () => {
        mem.permissions = { ask: ["Bash(echo *)"] };
        const requests = fakeBridge(["once"]);
        expect(await run("echo asked")).toContain("asked");
        expect(requests.length).toBe(1);
        expect(requests[0].title).toContain("Bash(echo *)");
    });

    test("ask rule with no bridge fails closed (print mode)", async () => {
        mem.permissions = { ask: ["Bash(echo *)"] };
        expect(run("echo headless")).rejects.toThrow(/interactive user approval/);
    });

    test("a remembered grant satisfies an ask rule without re-prompting", async () => {
        mem.permissions = { ask: ["Bash(echo *)"] };
        mem.bashAllow = ["echo"];
        const requests = fakeBridge(["deny"]);
        expect(await run("echo granted")).toContain("granted");
        expect(requests.length).toBe(0);
    });

    test("allow rule skips the bashApprove prompt", async () => {
        mem.bashApprove = true;
        mem.permissions = { allow: ["Bash(echo *)"] };
        const requests = fakeBridge(["deny"]);
        expect(await run("echo ruled")).toContain("ruled");
        expect(requests.length).toBe(0);
    });

    test("allow rule matches the whole command only — segments still prompt", async () => {
        mem.bashApprove = true;
        mem.permissions = { allow: ["Bash(echo *)"] };
        const requests = fakeBridge(["once"]);
        expect(await run("true && echo tail")).toContain("tail");
        expect(requests.length).toBe(1);
    });
});
