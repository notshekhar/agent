import { afterEach, describe, expect, test } from "bun:test";
import { getBuiltin } from "../src/extensions/builtin";
import {
    clearContextPolicy,
    decideContextAction,
    registerContextPolicy,
    type ContextDecisionInput,
} from "../src/agent/context-policy";
import { MIN_USABLE_TOKENS } from "../src/agent/rollover";
import type { Entry } from "../src/types";

/** Activate the real extension against a minimal api surface. */
async function activateRelay(own: Record<string, unknown> = {}): Promise<void> {
    const api = {
        extension: { dir: "", manifest: { name: "relay" }, log: () => {}, setStatus: () => {} },
        version: "0.3.1",
        settings: {
            getOwn: (k: string, f?: unknown) => own[k] ?? f,
            setOwn: (k: string, v: unknown) => {
                own[k] = v;
            },
            get: () => undefined,
            set: () => {},
        },
        tools: { add: () => {}, remove: () => {}, grant: () => {}, onCall: () => {}, onResult: () => {}, summary: () => {} },
        commands: { register: () => {}, unregister: () => {}, override: () => {} },
        turn: { use: () => {} },
        context: {
            registerPolicy: registerContextPolicy,
            requestBoundary: () => {},
            read: () => undefined,
            branch: () => [],
        },
    };
    await getBuiltin("relay")!.module.activate!(api as never);
}

const branch: Entry[] = [
    { type: "message", role: "user", content: "port the parser", ts: 1, id: "u1", parentId: null } as Entry,
    { type: "message", role: "assistant", content: "on it", ts: 2, id: "a1", parentId: "u1" } as Entry,
    { type: "message", role: "user", content: "keep going", ts: 3, id: "u2", parentId: "a1" } as Entry,
];

const fakeSession = {
    getBranch: () => branch,
    messages: () => branch.filter((e) => e.type === "message"),
} as never;

const input = (over: Partial<ContextDecisionInput> = {}): ContextDecisionInput => ({
    session: fakeSession,
    modelId: "x/y",
    cwd: "/repo",
    usedTokens: 90_000,
    contextWindow: 128_000,
    overheadTokens: 12_000,
    thresholdTokens: 102_400,
    reason: "threshold",
    ...over,
});

afterEach(() => clearContextPolicy());

describe("relay context policy", () => {
    test("rolls over with a handoff, cutting at the CURRENT user message", async () => {
        await activateRelay();
        const d = await decideContextAction(input());
        expect(d.kind).toBe("rollover");
        if (d.kind !== "rollover") return;
        expect(d.handoff).toContain("port the parser");
        // The user's message for this turn is already appended when the
        // threshold check runs; cutting at messages.length would discard the
        // request they just typed.
        expect(d.cutAt).toBe(branch.filter((e) => e.type === "message").length - 1);
    });

    /**
     * The floor. Summarization no-ops when there is nothing new to cut, but
     * cutAt advances every turn, so without this a cramped window would roll
     * over on EVERY turn and throw each one away as it completed.
     */
    test("declines when the window cannot hold a handoff plus working room", async () => {
        await activateRelay();
        const tight = await decideContextAction(
            input({ thresholdTokens: MIN_USABLE_TOKENS + 5_000, overheadTokens: 5_001 }),
        );
        expect(tight.kind).toBe("summarize");
    });

    test("mode off hands the turn back to loop's summarizer", async () => {
        await activateRelay({ mode: "off" });
        expect((await decideContextAction(input())).kind).toBe("summarize");
    });

    test("a window with nothing worth carrying falls back rather than dropping it", async () => {
        await activateRelay();
        const empty = { getBranch: () => [], messages: () => [] } as never;
        expect((await decideContextAction(input({ session: empty }))).kind).toBe("summarize");
    });

    test("with no policy registered, core summarizes exactly as before", async () => {
        clearContextPolicy();
        expect((await decideContextAction(input())).kind).toBe("summarize");
    });

    test("a second policy is refused — load order must not decide the boundary", async () => {
        await activateRelay();
        registerContextPolicy({ name: "impostor", decide: () => ({ kind: "none" }) });
        const d = await decideContextAction(input());
        expect(d.kind).toBe("rollover");
    });

    test("a throwing policy falls back to summarize rather than costing the turn", async () => {
        clearContextPolicy();
        registerContextPolicy({
            name: "broken",
            decide: () => {
                throw new Error("boom");
            },
        });
        expect((await decideContextAction(input())).kind).toBe("summarize");
    });
});
