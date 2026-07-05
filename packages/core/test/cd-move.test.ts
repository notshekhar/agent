import { describe, expect, test } from "bun:test";
import { SessionManager, getSessionStore } from "../src/sessions";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

describe("SessionManager.moveSession (/cd)", () => {
    test("re-homes the DB row, the in-memory info, and the list() buckets", async () => {
        const manager = new SessionManager();
        const session = await manager.create({ cwd: "/tmp/proj-a", provider: "anthropic", model: "anthropic/x" });
        await session.append({ type: "message", role: "user", content: "hi", ts: 0 });

        manager.moveSession(session, "/tmp/proj-b");

        expect(session.info.cwd).toBe("/tmp/proj-b");
        expect(session.path).toContain("--tmp-proj-b--");
        expect(getSessionStore().getSession(session.id)?.info.cwd).toBe("/tmp/proj-b");
        expect(manager.list("/tmp/proj-b").some((s) => s.id === session.id)).toBe(true);
        expect(manager.list("/tmp/proj-a").some((s) => s.id === session.id)).toBe(false);
    });
});
