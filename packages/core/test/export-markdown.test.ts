import { describe, expect, test } from "bun:test";
import { Session, sessionToMarkdown } from "../src/sessions";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

const ts = 0;

function sessionWith(entries: Entry[]): Session {
    const cloned = entries.map((e) => JSON.parse(JSON.stringify(e)) as Entry);
    return new Session(
        { id: "md-t", createdAt: 0, cwd: "/tmp", provider: "anthropic", model: "anthropic/x" },
        "/tmp/fake.jsonl",
        cloned,
    );
}

describe("sessionToMarkdown (/share)", () => {
    test("renders user/assistant text, collapses tool calls, skips tool results", () => {
        const md = sessionToMarkdown(
            sessionWith([
                { type: "message", role: "user", content: "fix the bug", ts },
                {
                    type: "message",
                    role: "assistant",
                    content: [
                        { type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "/a.ts" } },
                        { type: "text", text: "done, fixed it" },
                    ],
                    ts,
                },
                {
                    type: "message",
                    role: "tool",
                    content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: "SECRET_RAW" }],
                    ts,
                },
            ]),
        );
        expect(md).toContain("## User");
        expect(md).toContain("fix the bug");
        expect(md).toContain("tool: `read`");
        expect(md).toContain("done, fixed it");
        expect(md).not.toContain("SECRET_RAW");
    });

    test("includes compact summaries and subagent reports", () => {
        const md = sessionToMarkdown(
            sessionWith([
                { type: "message", role: "user", content: "hello", ts },
                { type: "compact", summary: "earlier we did X", cutAt: 1, ts, tokensBefore: 1, tokensAfter: 1 },
                { type: "subagent", agent: "fork", prompt: "p", result: "subagent findings", ts } as Entry,
            ]),
        );
        expect(md).toContain("[context compacted]");
        expect(md).toContain("earlier we did X");
        expect(md).toContain("subagent findings");
    });
});
