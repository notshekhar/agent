import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../src/sessions/db";
import {
    getProjectModel,
    getProjectProviderModel,
    migrateProjectStores,
    setProjectModel,
} from "../src/sessions/projects";
import { getTrustDecision, isTrusted, setTrust, trustForSession } from "../src/agent/trust";
import {
    addReminder,
    deleteReminder,
    listReminders,
    MAX_REMINDERS,
    refreshReminders,
    ReminderLimitError,
    updateReminder,
} from "../src/reminders";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();
afterEach(() => refreshReminders());

describe("projects table: trust", () => {
    test("undecided dir is null; set/get round-trips; nearest ancestor wins", () => {
        expect(getTrustDecision("/tmp/loop-trust-x/child")).toBeNull();
        setTrust("/tmp/loop-trust-x", true);
        // ancestor decision flows down
        expect(getTrustDecision("/tmp/loop-trust-x/child")).toBe(true);
        expect(isTrusted("/tmp/loop-trust-x/child")).toBe(true);
        // a nearer explicit "no" overrides the trusted ancestor
        setTrust("/tmp/loop-trust-x/child", false);
        expect(getTrustDecision("/tmp/loop-trust-x/child/deeper")).toBe(false);
    });

    test("session-only trust is process-local, not persisted", () => {
        trustForSession("/tmp/loop-trust-sess");
        expect(isTrusted("/tmp/loop-trust-sess")).toBe(true);
        const row = getDb()
            .query<{ trust: number | null }, [string]>("SELECT trust FROM projects WHERE dir = ?")
            .get("/tmp/loop-trust-sess");
        expect(row).toBeNull();
    });
});

describe("projects table: model memory", () => {
    test("last pick round-trips; per-provider memory tracks it", () => {
        expect(getProjectModel("/tmp/loop-proj")).toBeUndefined();
        setProjectModel("/tmp/loop-proj", "xai/grok-build-0.1");
        setProjectModel("/tmp/loop-proj", "anthropic/claude-opus-4-5");
        expect(getProjectModel("/tmp/loop-proj")).toBe("anthropic/claude-opus-4-5");
        // switching providers and back restores the per-provider pick
        expect(getProjectProviderModel("/tmp/loop-proj", "xai")).toBe("xai/grok-build-0.1");
        expect(getProjectProviderModel("/tmp/loop-proj", "anthropic")).toBe("anthropic/claude-opus-4-5");
    });

    test("model pick and trust share one row without clobbering each other", () => {
        setTrust("/tmp/loop-both", true);
        setProjectModel("/tmp/loop-both", "xai/grok-build-0.1");
        expect(isTrusted("/tmp/loop-both")).toBe(true);
        expect(getProjectModel("/tmp/loop-both")).toBe("xai/grok-build-0.1");
    });
});

describe("reminders table", () => {
    test("add/list/update/delete round-trip, both kinds", () => {
        const once = addReminder("stand up", { kind: "once", at: 1_800_000_000_000 });
        const cron = addReminder("water", { kind: "cron", expr: "0 * * * *" });
        expect(listReminders()).toHaveLength(2);

        const updated = updateReminder(once.id, { text: "stretch", schedule: { kind: "cron", expr: "*/5 * * * *" } });
        expect(updated).toMatchObject({ id: once.id, text: "stretch", kind: "cron", expr: "*/5 * * * *" });
        // kind switch left no stale `at`
        const row = listReminders().find((r) => r.id === once.id)!;
        expect("at" in row && (row as { at?: number }).at).toBeFalsy();

        expect(updateReminder(cron.id, { enabled: false })?.enabled).toBe(false);
        expect(deleteReminder(once.id)).toBe(true);
        expect(deleteReminder(once.id)).toBe(false);
        expect(listReminders()).toHaveLength(1);
    });

    test("MAX_REMINDERS is enforced", () => {
        for (let i = 0; i < MAX_REMINDERS; i++) addReminder(`r${i}`, { kind: "once", at: i });
        expect(() => addReminder("overflow", { kind: "once", at: 0 })).toThrow(ReminderLimitError);
    });
});

describe("store migration (trust.json + settings keys + reminders.json)", () => {
    // Injected sources: a temp loop dir + a mock settings store, so the
    // user's real ~/.loop files are never read or written.
    let configDir: string;
    beforeEach(() => {
        configDir = mkdtempSync(join(tmpdir(), "loop-stores-"));
        mkdirSync(configDir, { recursive: true });
    });
    afterEach(() => rmSync(configDir, { recursive: true, force: true }));

    const mockSettings = (data: Record<string, unknown>) => ({
        get: (key: string) => data[key],
        delete: (key: string) => {
            delete data[key];
        },
        data,
    });

    test("copies all three stores once, then gates", () => {
        writeFileSync(`${configDir}/trust.json`, JSON.stringify({ "/repo/a": true, "/repo/b": false, "/bad": "junk" }));
        writeFileSync(
            `${configDir}/reminders.json`,
            JSON.stringify({
                reminders: [
                    { id: "R1", text: "hi", enabled: true, kind: "once", at: 123 },
                    { id: "R2", text: "cronny", enabled: false, kind: "cron", expr: "* * * * *" },
                    { id: "", text: "invalid" },
                ],
            }),
        );
        const settings = mockSettings({
            projectModels: { "/repo/a": "xai/grok-build-0.1" },
            projectProviderModels: { "/repo/a": { xai: "xai/grok-build-0.1" } },
        });

        migrateProjectStores({ configDir, settings });

        expect(getTrustDecision("/repo/a")).toBe(true);
        expect(getTrustDecision("/repo/b")).toBe(false);
        expect(getTrustDecision("/bad")).toBeNull(); // junk value skipped
        expect(getProjectModel("/repo/a")).toBe("xai/grok-build-0.1");
        expect(getProjectProviderModel("/repo/a", "xai")).toBe("xai/grok-build-0.1");
        refreshReminders();
        const rems = listReminders();
        expect(rems).toHaveLength(2);
        expect(rems.find((r) => r.id === "R2")).toMatchObject({ kind: "cron", enabled: false });
        // the settings keys are retired
        expect(settings.data.projectModels).toBeUndefined();
        expect(settings.data.projectProviderModels).toBeUndefined();

        // re-run is a no-op (gate set) — existing rows keep their values
        setTrust("/repo/a", false);
        migrateProjectStores({ configDir, settings });
        expect(getTrustDecision("/repo/a")).toBe(false);
    });

    test("corrupt files are skipped, migration still gates", () => {
        writeFileSync(`${configDir}/trust.json`, "{not json");
        migrateProjectStores({ configDir, settings: mockSettings({}) });
        const gate = getDb()
            .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'stores_migrated_at'")
            .get();
        expect(gate).not.toBeNull();
    });
});
