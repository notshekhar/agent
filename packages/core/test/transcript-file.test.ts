import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Session } from "../src/sessions";
import { materializeTranscript, resetTranscriptCache, sessionToJsonl } from "../src/sessions/transcript-file";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

const dirs: string[] = [];
function mkSession(id = "hooktx") {
    const dir = mkdtempSync(join(tmpdir(), "loop-transcript-"));
    dirs.push(dir);
    const info = { id, createdAt: 0, cwd: dir, provider: "anthropic" as const, model: "m0" };
    return new Session(info, join(dir, "nested", `${id}.jsonl`), []);
}
const user = (c: string, ts: number): Entry => ({ type: "message", role: "user", content: c, ts });

afterEach(() => {
    resetTranscriptCache();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("sessionToJsonl", () => {
    test("one JSON entry per line", () => {
        const entries: Entry[] = [user("a", 1), user("b", 2)];
        const lines = sessionToJsonl(entries).split("\n");
        expect(lines.length).toBe(2);
        expect(lines.map((l) => (JSON.parse(l) as { content: string }).content)).toEqual(["a", "b"]);
    });
});

describe("materializeTranscript", () => {
    test("writes the session's entries as JSONL at the public path", async () => {
        const s = mkSession();
        await s.append(user("hello", 1));
        materializeTranscript(s.path);
        expect(existsSync(s.path)).toBe(true);
        const lines = readFileSync(s.path, "utf8").split("\n");
        expect(lines.length).toBe(1);
        expect((JSON.parse(lines[0]) as { content: string }).content).toBe("hello");
    });

    test("skips the rewrite when entries are unchanged, rewrites after an append", async () => {
        const s = mkSession("stale");
        await s.append(user("one", 1));
        materializeTranscript(s.path);
        const first = statSync(s.path).mtimeMs;
        // Unchanged → no write (mtime identical even on coarse filesystems,
        // because the file is not reopened at all).
        await new Promise((r) => setTimeout(r, 5));
        materializeTranscript(s.path);
        expect(statSync(s.path).mtimeMs).toBe(first);
        // A new entry invalidates the guard.
        await s.append(user("two", 2));
        materializeTranscript(s.path);
        const lines = readFileSync(s.path, "utf8").split("\n");
        expect(lines.length).toBe(2);
        expect((JSON.parse(lines[1]) as { content: string }).content).toBe("two");
    });

    test("unknown session or non-jsonl path is a silent no-op", () => {
        materializeTranscript("/nonexistent/dir/nope.jsonl");
        materializeTranscript("/etc/hosts");
        expect(existsSync("/nonexistent/dir/nope.jsonl")).toBe(false);
    });
});

describe("runHooks materialization seam", () => {
    test("a matching hook makes transcript_path readable; no hooks → no file", async () => {
        const { runHooks } = await import("../src/agent/hooks");
        const { getSetting, setSetting } = await import("../src/settings");
        const savedHooks = getSetting("hooks");
        const savedImport = getSetting("importClaudeHooks");
        try {
            // Only the in-memory user layer — keep the user's real Claude
            // hooks out of the merge so no foreign command runs in tests.
            setSetting("importClaudeHooks", false);
            setSetting("hooks", {});
            const bare = mkSession("nohooks");
            await bare.append(user("ping", 1));
            await runHooks("SessionEnd", undefined, { session_id: bare.id, transcript_path: bare.path }, bare.info.cwd);
            expect(existsSync(bare.path)).toBe(false);

            setSetting("hooks", { SessionEnd: [{ hooks: [{ type: "command", command: "true" }] }] });
            // Fresh session = fresh cwd — sidesteps loadHooksConfig's 1s
            // per-cwd merged-config cache, which would still see {}.
            const s = mkSession("viahook");
            await s.append(user("ping", 1));
            await runHooks("SessionEnd", undefined, { session_id: s.id, transcript_path: s.path }, s.info.cwd);
            expect(existsSync(s.path)).toBe(true);
            expect((JSON.parse(readFileSync(s.path, "utf8")) as { content: string }).content).toBe("ping");
        } finally {
            setSetting("hooks", savedHooks);
            setSetting("importClaudeHooks", savedImport);
        }
    });
});
