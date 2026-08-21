import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
    setBashApprovalBridge,
    type BashApprovalDecision,
    type BashApprovalRequest,
} from "../src/tools/approval-bridge";

// In-memory settings so permission rules and approval settings stay inert.
const mem: Record<string, unknown> = {};
mock.module("../src/settings", () => ({
    getSetting: (k: string) => mem[k],
    setSetting: (k: string, v: unknown) => {
        mem[k] = v;
    },
}));

const { createEditTool } = await import("../src/tools/edit");
const { createWriteTool } = await import("../src/tools/write");
const { createEnterPlanModeTool } = await import("../src/tools/enter-plan-mode");
const { createExitPlanModeTool, planHeadline } = await import("../src/tools/exit-plan-mode");
const { isPlanModeActive, setPlanMode } = await import("../src/tools/utils/plan-mode");
const { clearPermissionRulesCache } = await import("../src/tools/utils/permission-rules");
const { recordRead } = await import("../src/tools/utils/read-registry");

let dir: string;
const SID = "plan-test-session";

beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k];
    clearPermissionRulesCache();
    setBashApprovalBridge(null);
    setPlanMode(SID, false);
    dir = mkdtempSync(join(tmpdir(), "loop-planmode-"));
    writeFileSync(join(dir, "a.txt"), "hello\n");
});

afterEach(() => {
    setPlanMode(SID, false);
    rmSync(dir, { recursive: true, force: true });
});

type ExecTool = { execute: (input: object, options: object) => Promise<string> };
const exec = (t: unknown, input: object) => (t as ExecTool).execute(input, { toolCallId: "t1", messages: [] });

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

describe("plan mode tool gating", () => {
    test("edit and write reject while plan mode is active for the session", async () => {
        recordRead(join(dir, "a.txt"), SID);
        setPlanMode(SID, true);
        const edit = createEditTool({ cwd: dir, sessionId: SID });
        const write = createWriteTool({ cwd: dir, sessionId: SID });
        expect(exec(edit, { path: "a.txt", edits: [{ oldText: "hello", newText: "bye" }] })).rejects.toThrow(
            /Plan mode is active/,
        );
        expect(exec(write, { path: "b.txt", content: "x" })).rejects.toThrow(/Plan mode is active/);
    });

    test("other sessions are unaffected", async () => {
        setPlanMode(SID, true);
        const write = createWriteTool({ cwd: dir, sessionId: "other-session" });
        expect(await exec(write, { path: "c.txt", content: "ok" })).toContain("Successfully");
    });

    test("clearing plan mode restores edits", async () => {
        setPlanMode(SID, true);
        setPlanMode(SID, false);
        const write = createWriteTool({ cwd: dir, sessionId: SID });
        expect(await exec(write, { path: "d.txt", content: "ok" })).toContain("Successfully");
    });
});

describe("enter_plan_mode tool", () => {
    test("approval flips plan mode on and reports the new rules", async () => {
        const requests = fakeBridge(["once"]);
        const enter = createEnterPlanModeTool({ sessionId: SID, cwd: dir });
        const out = await exec(enter, { reason: "architecture is ambiguous" });
        expect(out).toContain("Plan mode is ON");
        expect(isPlanModeActive(SID)).toBe(true);
        expect(requests[0].kind).toBe("plan");
        expect(requests[0].command).toContain("ambiguous");
    });

    test("decline leaves plan mode off and tells the model not to re-ask", async () => {
        fakeBridge(["deny"]);
        const enter = createEnterPlanModeTool({ sessionId: SID, cwd: dir });
        const out = await exec(enter, { reason: "r" });
        expect(out).toContain("declined");
        expect(isPlanModeActive(SID)).toBe(false);
    });

    test("no bridge → unavailable, no crash", async () => {
        const enter = createEnterPlanModeTool({ sessionId: SID, cwd: dir });
        const out = await exec(enter, { reason: "r" });
        expect(out).toContain("unavailable");
        expect(isPlanModeActive(SID)).toBe(false);
    });

    test("already active → no prompt", async () => {
        setPlanMode(SID, true);
        const requests = fakeBridge(["once"]);
        const enter = createEnterPlanModeTool({ sessionId: SID, cwd: dir });
        const out = await exec(enter, { reason: "r" });
        expect(out).toContain("already active");
        expect(requests.length).toBe(0);
    });
});

// A plan long enough to clear PLAN_MIN_CHARS (200).
const REAL_PLAN = `# Add the widget cache

## Context
Widgets are refetched on every render, which is why the list flickers.

## Steps
1. src/widgets.ts — memoize fetchWidget by id, mirroring the userCache above it.
2. src/list.tsx — read through the cache instead of calling fetchWidget directly.

## Verification
bun test packages/widgets — the flicker test currently fails.

## Risks
Cache invalidation on logout is left to the user to decide.`;

describe("exit_plan_mode tool", () => {
    test("approval lifts the gate and tells the model to implement now", async () => {
        setPlanMode(SID, true);
        const requests = fakeBridge(["once"]);
        const exit = createExitPlanModeTool({ sessionId: SID, cwd: dir });
        const out = await exec(exit, { plan: REAL_PLAN });
        expect(out).toContain("plan mode is OFF");
        expect(out).toContain("same turn");
        expect(isPlanModeActive(SID)).toBe(false);
        expect(requests[0].kind).toBe("exit-plan");
        // The prompt shows the plan's heading, not the whole document.
        expect(requests[0].command).toBe("Add the widget cache");
    });

    test("edits work again after an approved exit", async () => {
        setPlanMode(SID, true);
        fakeBridge(["once"]);
        const exit = createExitPlanModeTool({ sessionId: SID, cwd: dir });
        await exec(exit, { plan: REAL_PLAN });
        const write = createWriteTool({ cwd: dir, sessionId: SID });
        expect(await exec(write, { path: "e.txt", content: "ok" })).toContain("Successfully");
    });

    test("decline keeps the gate shut and invites a revised plan", async () => {
        setPlanMode(SID, true);
        fakeBridge(["deny"]);
        const exit = createExitPlanModeTool({ sessionId: SID, cwd: dir });
        const out = await exec(exit, { plan: REAL_PLAN });
        expect(out).toContain("stays ON");
        expect(isPlanModeActive(SID)).toBe(true);
        const write = createWriteTool({ cwd: dir, sessionId: SID });
        expect(exec(write, { path: "f.txt", content: "x" })).rejects.toThrow(/Plan mode is active/);
    });

    test("a title-only delivery is rejected without prompting", async () => {
        setPlanMode(SID, true);
        const requests = fakeBridge(["once"]);
        const exit = createExitPlanModeTool({ sessionId: SID, cwd: dir });
        const out = await exec(exit, { plan: "# Do the thing" });
        expect(out).toContain("REJECTED");
        expect(requests.length).toBe(0);
        expect(isPlanModeActive(SID)).toBe(true);
    });

    test("no bridge → the gate holds, no crash", async () => {
        setPlanMode(SID, true);
        const exit = createExitPlanModeTool({ sessionId: SID, cwd: dir });
        const out = await exec(exit, { plan: REAL_PLAN });
        expect(out).toContain("only be lifted by the user");
        expect(isPlanModeActive(SID)).toBe(true);
    });

    test("not in plan mode → no prompt, nothing to exit", async () => {
        const requests = fakeBridge(["once"]);
        const exit = createExitPlanModeTool({ sessionId: SID, cwd: dir });
        const out = await exec(exit, { plan: REAL_PLAN });
        expect(out).toContain("not active");
        expect(requests.length).toBe(0);
    });

    test("planHeadline strips the marker and falls back past blank lines", () => {
        expect(planHeadline("\n\n## Refactor the parser\nbody")).toBe("Refactor the parser");
        expect(planHeadline(`# ${"x".repeat(200)}`).length).toBeLessThanOrEqual(100);
    });
});
