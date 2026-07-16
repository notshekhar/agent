import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
    setBashApprovalBridge,
    type BashApprovalDecision,
    type BashApprovalRequest,
} from "../src/tools/approval-bridge";

// In-memory settings (same pattern as bash-approve.test.ts) so `permissions`
// rules come from the test, not the real ~/.loop/settings.json.
const mem: Record<string, unknown> = {};
mock.module("../src/settings", () => ({
    getSetting: (k: string) => mem[k],
    setSetting: (k: string, v: unknown) => {
        mem[k] = v;
    },
}));

const { createReadTool } = await import("../src/tools/read");
const { createEditTool } = await import("../src/tools/edit");
const { createWriteTool } = await import("../src/tools/write");
const { createGrepTool } = await import("../src/tools/grep");
const { clearPermissionRulesCache } = await import("../src/tools/utils/permission-rules");
const { recordRead } = await import("../src/tools/utils/read-registry");

let dir: string;

beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k];
    clearPermissionRulesCache();
    setBashApprovalBridge(null);
    dir = mkdtempSync(join(tmpdir(), "loop-pathperm-"));
    mkdirSync(join(dir, "secrets"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "secrets", "key.pem"), "SECRET");
    writeFileSync(join(dir, "src", "main.ts"), "export {}\n");
});

afterEach(() => {
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

describe("path permission rules", () => {
    test("Read deny blocks a file read (relative and absolute)", async () => {
        mem.permissions = { deny: ["Read(secrets/**)"] };
        const read = createReadTool({ cwd: dir });
        expect(exec(read, { path: "secrets/key.pem" })).rejects.toThrow(/permission rule/);
        expect(exec(read, { path: join(dir, "secrets", "key.pem") })).rejects.toThrow(/permission rule/);
        // Unmatched paths still read fine.
        expect(await exec(read, { path: "src/main.ts" })).toContain("export");
    });

    test("Edit deny blocks edit and write", async () => {
        mem.permissions = { deny: ["Edit(**/*.pem)"] };
        recordRead(join(dir, "secrets", "key.pem"));
        const edit = createEditTool({ cwd: dir });
        const write = createWriteTool({ cwd: dir });
        expect(exec(edit, { path: "secrets/key.pem", edits: [{ oldText: "SECRET", newText: "X" }] })).rejects.toThrow(
            /permission rule/,
        );
        expect(exec(write, { path: "secrets/other.pem", content: "X" })).rejects.toThrow(/permission rule/);
        // Read rules do not block edits and vice versa.
        expect(await exec(write, { path: "src/new.ts", content: "ok" })).toContain("Successfully");
    });

    test("Read deny governs grep searches", async () => {
        mem.permissions = { deny: ["Read(secrets/**)"] };
        const grep = createGrepTool({ cwd: dir });
        expect(exec(grep, { pattern: "SECRET", path: "secrets" })).rejects.toThrow(/permission rule/);
    });

    test("ask rule prompts and allow-once proceeds", async () => {
        mem.permissions = { ask: ["Read(secrets/**)"] };
        const requests = fakeBridge(["once"]);
        const read = createReadTool({ cwd: dir });
        expect(await exec(read, { path: "secrets/key.pem" })).toContain("SECRET");
        expect(requests.length).toBe(1);
        expect(requests[0].kind).toBe("path");
    });

    test("ask rule denied by the user refuses", async () => {
        mem.permissions = { ask: ["Edit(src/**)"] };
        fakeBridge(["deny"]);
        const write = createWriteTool({ cwd: dir });
        expect(exec(write, { path: "src/blocked.ts", content: "x" })).rejects.toThrow(/declined/);
    });

    test("ask rule with no bridge fails closed", async () => {
        mem.permissions = { ask: ["Read(secrets/**)"] };
        const read = createReadTool({ cwd: dir });
        expect(exec(read, { path: "secrets/key.pem" })).rejects.toThrow(/interactive user approval/);
    });
});
