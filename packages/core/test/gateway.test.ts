import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getGateway, listGateways, listConfiguredGateways, listEnabledGateways } from "../src/gateway/registry";
import { telegramGateway } from "../src/gateway/telegram-gateway";
import {
    claimGatewayPid,
    clearGatewayPid,
    clearOwnGatewayPid,
    gatewayLogPath,
    gatewayPidPath,
    isGatewayRunning,
    liveGatewayPid,
    stopGatewayDaemon,
} from "../src/gateway/daemon";

describe("gateway registry", () => {
    test("lists Telegram and looks it up by id", () => {
        const ids = listGateways().map((g) => g.id);
        expect(ids).toContain("telegram");
        expect(getGateway("telegram")).toBe(telegramGateway);
        expect(getGateway("nope")).toBeUndefined();
    });

    test("configured/enabled sublists are subsets of all gateways", () => {
        const all = new Set(listGateways().map((g) => g.id));
        for (const g of listConfiguredGateways()) expect(all.has(g.id)).toBe(true);
        // Enabled implies configured, by construction.
        for (const g of listEnabledGateways()) expect(g.isConfigured()).toBe(true);
    });
});

describe("telegram gateway adapter", () => {
    test("exposes the uniform Gateway shape", () => {
        expect(telegramGateway.id).toBe("telegram");
        expect(telegramGateway.displayName).toBe("Telegram");
        const st = telegramGateway.status();
        expect(typeof st.configured).toBe("boolean");
        expect(typeof st.enabled).toBe("boolean");
        expect(typeof st.summary).toBe("string");
        expect(Array.isArray(st.detail)).toBe(true);
    });
});

describe("gateway daemon pidfiles", () => {
    // A throwaway id, unique per run, so these never collide with a real gateway
    // in the shared config dir; afterAll removes the file it created.
    const ID = `test-gw-${process.pid}`;

    afterAll(() => {
        clearGatewayPid(ID);
    });

    test("pid + log paths are named per gateway", () => {
        expect(gatewayPidPath(ID)).toContain(`gateway-${ID}.pid`);
        expect(gatewayLogPath(ID)).toContain(`gateway-${ID}.log`);
    });

    test("claim writes this process's pid; live + running observe it", () => {
        expect(isGatewayRunning(ID)).toBe(false);
        claimGatewayPid(ID);
        expect(liveGatewayPid(ID)).toBe(process.pid);
        expect(isGatewayRunning(ID)).toBe(true);
    });

    test("a second claim refuses (one poller only)", () => {
        expect(() => claimGatewayPid(ID)).toThrow(/already running/);
    });

    test("clear removes the pidfile", () => {
        clearGatewayPid(ID);
        expect(isGatewayRunning(ID)).toBe(false);
        expect(liveGatewayPid(ID)).toBeNull();
    });

    test("clearOwn only removes the pidfile when this process owns it", () => {
        // Someone else's pid in the file: our exit handler must leave it alone.
        writeFileSync(gatewayPidPath(ID), "2147483646");
        clearOwnGatewayPid(ID);
        expect(liveGatewayPid(ID)).toBeNull(); // still stale-but-present
        expect(readFileSync(gatewayPidPath(ID), "utf8").trim()).toBe("2147483646");
        // Our own pid: removed.
        claimGatewayPid(ID);
        clearOwnGatewayPid(ID);
        expect(existsSync(gatewayPidPath(ID))).toBe(false);
    });

    test("a stale pidfile (dead pid) reads as not running", () => {
        // A pid that cannot exist — process.kill(pid, 0) throws ESRCH.
        writeFileSync(gatewayPidPath(ID), "2147483646");
        expect(liveGatewayPid(ID)).toBeNull();
        // stop cleans up the stale file and reports nothing was running.
        const r = stopGatewayDaemon(ID);
        expect(r.stopped).toBe(false);
        expect(isGatewayRunning(ID)).toBe(false);
    });
});
