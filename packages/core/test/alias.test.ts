import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CommandContext } from "../src/commands";

// In-memory settings so /alias never writes the real ~/.loop/settings.json.
const mem: Record<string, unknown> = {};
mock.module("../src/settings", () => ({
    getSetting: (k: string) => mem[k],
    setSetting: (k: string, v: unknown) => {
        mem[k] = v;
    },
}));

const { CommandRegistry, registerBuiltins, registerAliasCommand } = await import("../src/commands");

function makeCtx() {
    const events: Array<{ event: string; data?: unknown }> = [];
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const ctx = {
        emit: (event: string, data?: unknown) => void events.push({ event, data }),
        exit: () => void calls.push({ fn: "exit", args: [] }),
        setThinking: (level?: string) => void calls.push({ fn: "setThinking", args: [level] }),
    } as unknown as CommandContext;
    return { ctx, events, calls };
}

async function makeReg() {
    const reg = new CommandRegistry();
    await registerBuiltins(reg, { cwd: "/nonexistent-alias-test" });
    return reg;
}

beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k];
});

describe("/alias", () => {
    test("defines an alias, persists it, and dispatches through it", async () => {
        const reg = await makeReg();
        const { ctx, events, calls } = makeCtx();

        await reg.run("/alias q /quit", ctx);
        expect(mem.aliases).toEqual({ q: "/quit" });
        expect(reg.has("q")).toBe(true);
        expect(events.some((e) => e.event === "commands-changed")).toBe(true);

        await reg.run("/q", ctx);
        expect(calls).toEqual([{ fn: "exit", args: [] }]);
    });

    test("appends extra args to the expansion", async () => {
        const reg = await makeReg();
        const { ctx, calls } = makeCtx();

        await reg.run("/alias th /thinking", ctx);
        await reg.run("/th high", ctx);
        expect(calls).toEqual([{ fn: "setThinking", args: ["high"] }]);
    });

    test("lists aliases and removes them", async () => {
        const reg = await makeReg();
        const { ctx, events } = makeCtx();

        await reg.run("/alias q /quit", ctx);
        await reg.run("/alias", ctx);
        const list = events.filter((e) => e.event === "help").at(-1);
        expect(String(list?.data)).toContain("→ /quit");

        await reg.run("/alias rm q", ctx);
        expect(reg.has("q")).toBe(false);
        expect(mem.aliases).toEqual({});
    });

    test("refuses names that collide with real commands", async () => {
        const reg = await makeReg();
        const { ctx, events } = makeCtx();

        await reg.run("/alias model /quit", ctx);
        expect(events.some((e) => e.event === "error")).toBe(true);
        expect(mem.aliases ?? {}).toEqual({});
        expect(reg.get("model")?.description).not.toContain("Alias for");
    });

    test("refuses non-command expansions and bad names", async () => {
        const reg = await makeReg();
        const { ctx, events } = makeCtx();

        await reg.run("/alias q quit", ctx);
        await reg.run("/alias bad name /quit", ctx);
        expect(events.filter((e) => e.event === "error").length).toBe(2);
        expect(reg.has("q")).toBe(false);
    });

    test("registers persisted aliases on startup, real commands win", async () => {
        mem.aliases = { zz: "/quit", model: "/quit" };
        const reg = await makeReg();
        expect(reg.get("zz")?.description).toBe("Alias for /quit");
        expect(reg.get("model")?.description).not.toContain("Alias for");
    });

    test("breaks alias cycles instead of recursing forever", async () => {
        const reg = new CommandRegistry();
        registerAliasCommand(reg, "a", "/b");
        registerAliasCommand(reg, "b", "/a");
        const { ctx, events } = makeCtx();

        await reg.run("/a", ctx);
        expect(events.some((e) => e.event === "error" && String(e.data).includes("too deep"))).toBe(true);
    });

    test("reports unknown expansion targets at run time", async () => {
        const reg = new CommandRegistry();
        registerAliasCommand(reg, "z", "/nope");
        const { ctx, events } = makeCtx();

        await reg.run("/z", ctx);
        expect(events.some((e) => e.event === "error" && String(e.data).includes("unknown command"))).toBe(true);
    });
});
