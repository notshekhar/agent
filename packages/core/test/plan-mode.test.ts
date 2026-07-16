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
