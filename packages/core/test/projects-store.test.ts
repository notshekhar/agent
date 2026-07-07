import { afterEach, describe, expect, test } from "bun:test";
import { getDb } from "../src/sessions/db";
import { getProjectModel, getProjectProviderModel, setProjectModel } from "../src/sessions/projects";
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
