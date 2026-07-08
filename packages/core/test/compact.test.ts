import { describe, expect, test } from "bun:test";
import { compactCut, compactedContextEntries } from "../src/agent/compact";
import { Session } from "../src/sessions";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

function fakeSession(entries: Entry[]): Session {
    return new Session(
        { id: "t", createdAt: 0, cwd: "/tmp", provider: "xai", model: "xai/grok-build-0.1" },
        "/tmp/fake.jsonl",
        entries,
    );
}

const msg = (role: "user" | "assistant", content: string): Entry => ({ type: "message", role, content, ts: 0 });
const sub = (agent: string, result: string): Entry => ({ type: "subagent", ts: 0, agent, prompt: "p", result });

describe("compactedContextEntries", () => {
    test("no compact: messages and subagents interleave in order", () => {
        const out = compactedContextEntries(
            fakeSession([msg("user", "a"), sub("plan", "report"), msg("assistant", "b")]),
        );
        expect(out.map((e) => e.kind)).toEqual(["message", "subagent", "message"]);
    });

    test("an active todo list written before the cut is re-injected after the summary", () => {
        const items = [
            { content: "read code", status: "completed" },
            { content: "wire handler", status: "in_progress" },
        ];
        const out = compactedContextEntries(
            fakeSession([
                msg("user", "old-1"),
                { type: "custom", ts: 0, payload: { kind: "todos", items } } as Entry,
                msg("assistant", "old-2"),
                { type: "compact", summary: "SUMMARY", cutAt: 2, ts: 0, tokensBefore: 0, tokensAfter: 0 },
                msg("user", "new-1"),
            ]),
        );
        expect(String((out[0] as { content: unknown }).content)).toContain("SUMMARY");
        const todoMsg = String((out[1] as { content: unknown }).content);
        expect(todoMsg).toContain("todo checklist was active before the compaction");
        expect(todoMsg).toContain("2. [in_progress] wire handler");
        expect(out[2]).toMatchObject({ kind: "message", content: "new-1" });
    });

    test("a post-cut todo write supersedes the pre-cut list — no re-injection", () => {
        const pre = [{ content: "old", status: "in_progress" }];
        const post = [{ content: "new", status: "in_progress" }];
        const out = compactedContextEntries(
            fakeSession([
                { type: "custom", ts: 0, payload: { kind: "todos", items: pre } } as Entry,
                msg("user", "old-1"),
                msg("assistant", "old-2"),
                { type: "compact", summary: "SUMMARY", cutAt: 2, ts: 0, tokensBefore: 0, tokensAfter: 0 },
                msg("user", "new-1"),
                { type: "custom", ts: 0, payload: { kind: "todos", items: post } } as Entry,
            ]),
        );
        expect(out.some((e) => String((e as { content?: unknown }).content ?? "").includes("checklist"))).toBe(false);
    });

    test("an all-terminal pre-cut list is not re-injected", () => {
        const items = [
            { content: "a", status: "completed" },
            { content: "b", status: "cancelled" },
        ];
        const out = compactedContextEntries(
            fakeSession([
                { type: "custom", ts: 0, payload: { kind: "todos", items } } as Entry,
                msg("user", "old-1"),
                msg("assistant", "old-2"),
                { type: "compact", summary: "SUMMARY", cutAt: 2, ts: 0, tokensBefore: 0, tokensAfter: 0 },
                msg("user", "new-1"),
            ]),
        );
        expect(out.some((e) => String((e as { content?: unknown }).content ?? "").includes("checklist"))).toBe(false);
    });

    test("compact cut drops earlier messages and their subagents", () => {
        const out = compactedContextEntries(
            fakeSession([
                msg("user", "old-1"),
                sub("plan", "old-report"),
                msg("assistant", "old-2"),
                { type: "compact", summary: "SUMMARY", cutAt: 2, ts: 0, tokensBefore: 0, tokensAfter: 0 },
                msg("user", "new-1"),
                sub("default", "new-report"),
            ]),
        );
        // summary message + surviving entries
        expect(out[0]).toMatchObject({ kind: "message", role: "user" });
        expect(String((out[0] as { content: unknown }).content)).toContain("SUMMARY");
        const rest = out.slice(1);
        expect(rest).toEqual([
            { kind: "message", role: "user", content: "new-1" },
            { kind: "subagent", agent: "default", result: "new-report" },
        ]);
    });
});

describe("compactCut", () => {
    const roles = (rs: string[]) => rs.map((role) => ({ role }));

    test("plain numeric cut when the window starts on a user message", () => {
        expect(compactCut(roles(["user", "assistant", "user", "assistant"]), 0, 2)).toBe(2);
    });

    test("walks back over tool results so the window keeps the tool-call pair", () => {
        // cut would land on the tool result at index 3 — orphaning it from the
        // assistant tool-call at index 2.
        const messages = roles(["user", "assistant", "assistant", "tool", "assistant", "user"]);
        expect(compactCut(messages, 0, 3)).toBe(2);
    });

    test("walks back over consecutive tool messages", () => {
        const messages = roles(["user", "assistant", "tool", "tool", "assistant"]);
        expect(compactCut(messages, 0, 2)).toBe(1);
    });

    test("never walks below the previous cut", () => {
        // numeric cut lands exactly on previousCut, which is a tool message —
        // the walk-back must stop there rather than dig into compacted history.
        const messages = roles(["user", "assistant", "tool", "tool", "assistant"]);
        expect(compactCut(messages, 3, 2)).toBe(3);
    });

    test("keeps everything when history is shorter than keep", () => {
        expect(compactCut(roles(["user", "assistant"]), 0, 4)).toBe(0);
    });
});
