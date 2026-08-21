/**
 * Turn-assembly for plan mode: WHICH delivery tool a plan-mode turn gets.
 *
 * A plan-mode session must always have exactly one way out, and which one
 * depends on whether the running agent could act on an approval — the unit
 * tests in plan-mode.test.ts cover what each tool does, this covers the
 * choice between them, through a real runTurn against a mock model.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { Session } from "../src/sessions";
import { setBashApprovalBridge } from "../src/tools/approval-bridge";
import { setPlanMode } from "../src/tools/utils/plan-mode";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

// Delegating providers mock — bun module mocks leak across files, so getModel
// is only fake while a test sets currentModel (see abort-persistence.test.ts).
let currentModel: MockLanguageModelV3 | null = null;
const realProviders = await import("../src/providers");
mock.module("../src/providers", () => ({
    ...realProviders,
    getModel: async (...args: Parameters<typeof realProviders.getModel>) =>
        currentModel ?? realProviders.getModel(...args),
}));

const MODEL = "xai/grok-build-0.1";

function emptyStream() {
    return {
        stream: new ReadableStream({
            start(controller) {
                controller.enqueue({ type: "text-start", id: "t0" });
                controller.enqueue({ type: "text-delta", id: "t0", delta: "ok" });
                controller.enqueue({ type: "text-end", id: "t0" });
                controller.enqueue({
                    type: "finish",
                    finishReason: { unified: "stop", raw: "end_turn" },
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                });
                controller.close();
            },
        }),
    };
}

let dir: string;

/** Run one turn and report the tool names the model was actually offered. */
async function toolsOfferedThisTurn(opts: { planMode: boolean; bridge: boolean; agent?: string }) {
    let offered: string[] = [];
    let system = "";
    currentModel = new MockLanguageModelV3({
        doStream: async (call: any) => {
            offered = (call.tools ?? []).map((t: { name: string }) => t.name);
            system = JSON.stringify(call.prompt ?? "") + String(call.instructions ?? "");
            return emptyStream();
        },
    });
    setBashApprovalBridge(opts.bridge ? { confirm: async () => "once" as const } : null);
    const session = new Session(
        { id: "exit-plan-turn", createdAt: 0, cwd: dir, provider: "xai", model: MODEL },
        join(dir, "s.jsonl"),
        [],
    );
    setPlanMode(session.id, opts.planMode);
    const { runTurn, CostTracker } = await import("../src/agent");
    await runTurn({
        session,
        modelId: MODEL,
        userInput: "restructure the auth layer",
        cwd: dir,
        tracker: new CostTracker(),
        emitter: new EventEmitter() as never,
        ...(opts.agent ? { agent: opts.agent } : {}),
    });
    setPlanMode(session.id, false);
    return { offered, system };
}

describe("which exit a plan-mode turn is given", () => {
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "loop-exitplan-"));
    });
    afterEach(() => {
        currentModel = null;
        setBashApprovalBridge(null);
    });

    test("interactive + unrestricted → exit_plan_mode, and NOT the handoff plan tool", async () => {
        const { offered, system } = await toolsOfferedThisTurn({ planMode: true, bridge: true });
        // Guard the negative assertions below: an empty list would pass them all.
        expect(offered).toContain("read");
        expect(offered).toContain("exit_plan_mode");
        expect(offered).not.toContain("plan");
        // Entering again while already in plan mode is meaningless.
        expect(offered).not.toContain("enter_plan_mode");
        // The model is told it is planning instead of discovering it from a
        // rejected edit.
        expect(system).toContain("PLAN MODE IS ACTIVE");
    });

    test("no approval bridge (print mode / RPC) → the plan tool, nobody to ask", async () => {
        const { offered, system } = await toolsOfferedThisTurn({ planMode: true, bridge: false });
        expect(offered).toContain("plan");
        expect(offered).not.toContain("exit_plan_mode");
        expect(system).not.toContain("PLAN MODE IS ACTIVE");
    });

    test("the read-only plan agent keeps the plan tool — lifting the gate buys it nothing", async () => {
        const { offered } = await toolsOfferedThisTurn({ planMode: true, bridge: true, agent: "plan" });
        expect(offered).toContain("read");
        expect(offered).toContain("plan");
        expect(offered).not.toContain("exit_plan_mode");
    });

    test("no plan mode → neither delivery tool, only the entry request", async () => {
        const { offered } = await toolsOfferedThisTurn({ planMode: false, bridge: true });
        expect(offered).toContain("read");
        expect(offered).not.toContain("plan");
        expect(offered).not.toContain("exit_plan_mode");
        expect(offered).toContain("enter_plan_mode");
    });
});
