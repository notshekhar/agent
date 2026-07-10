import { beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

/**
 * Byte-identity gate for the UI-mode seam refactor: the default (loop mode)
 * rendering of every chat block must not change, ANSI bytes included. These
 * snapshots were captured BEFORE the seam existed — if a refactor changes any
 * of them, that is a regression in loop mode, not a snapshot to update.
 */
// Pin the color pipeline before the theme module reads COLORTERM.
process.env.COLORTERM = "truecolor";

import { ChatHistory } from "../src/interactive/components/chat-history";
import {
    AssistantMessageComponent,
    BranchSummaryMessageComponent,
    CompactionSummaryMessageComponent,
    DynamicBorder,
    SkillInvocationMessageComponent,
    parseSkillBlock,
    UserMessageComponent,
} from "../src/interactive/ui/messages";
import { ToolExecutionComponent } from "../src/interactive/ui/tool-execution";
import { initTheme } from "../src/interactive/ui/theme";

beforeAll(() => initTheme("dark"));

const tui = { requestRender() {} } as unknown as TUI;
const CWD = "/repo";
const W = 80;

describe("user + assistant messages", () => {
    test("user message (markdown, bg box, OSC zones)", () => {
        expect(new UserMessageComponent("fix the **auth** bug in `login.ts`").render(W)).toMatchSnapshot();
    });

    test("assistant text-only", () => {
        const c = new AssistantMessageComponent({
            content: [{ type: "text", text: "The bug is a missing `await` in the token refresh path." }],
            stopReason: "stop",
        });
        expect(c.render(W)).toMatchSnapshot();
    });

    test("assistant thinking then text", () => {
        const c = new AssistantMessageComponent({
            content: [
                { type: "thinking", thinking: "The user wants the auth bug fixed.\nLook at login.ts first." },
                { type: "text", text: "Found it — `refresh()` is not awaited." },
            ],
            stopReason: "stop",
        });
        expect(c.render(W)).toMatchSnapshot();
    });

    test("assistant aborted", () => {
        const c = new AssistantMessageComponent({
            content: [{ type: "text", text: "Let me check" }],
            stopReason: "aborted",
        });
        expect(c.render(W)).toMatchSnapshot();
    });

    test("assistant error", () => {
        const c = new AssistantMessageComponent({
            content: [],
            stopReason: "error",
            errorMessage: "connection reset",
        });
        expect(c.render(W)).toMatchSnapshot();
    });
});

describe("tool execution", () => {
    const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });

    test("pending bash (no result yet)", () => {
        expect(new ToolExecutionComponent("bash", { command: "bun test" }, tui, CWD).render(W)).toMatchSnapshot();
    });

    test("bash success, short output", () => {
        const c = new ToolExecutionComponent("bash", { command: "echo hi" }, tui, CWD);
        c.updateResult(result("hi"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("bash success, long output collapsed then expanded", () => {
        const c = new ToolExecutionComponent("bash", { command: "seq 12" }, tui, CWD);
        const lines = Array.from({ length: 12 }, (_, i) => String(i + 1)).join("\n");
        c.updateResult(result(lines), false);
        expect(c.render(W)).toMatchSnapshot();
        c.setExpanded(true);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("bash error output", () => {
        const c = new ToolExecutionComponent("bash", { command: "false" }, tui, CWD);
        c.updateResult(result("command failed", true), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("edit diff coloring", () => {
        const c = new ToolExecutionComponent("edit", { path: "/repo/src/a.ts" }, tui, CWD);
        c.updateResult(result("@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n context"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("read with line range + syntax highlight", () => {
        const c = new ToolExecutionComponent("read", { path: "/repo/src/a.ts", offset: 10, limit: 2 }, tui, CWD);
        c.updateResult(result("const x = 1;\nexport default x;"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("task pending with live status, then done with stats", () => {
        const c = new ToolExecutionComponent("task", { agent: "explore", prompt: "find the auth code" }, tui, CWD);
        c.updateStatus("read src/login.ts");
        expect(c.render(W)).toMatchSnapshot();
        c.setTaskStats({ steps: 3, durationMs: 41000, usd: 0.043 });
        c.updateResult(result("found it"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("sql input preview", () => {
        const c = new ToolExecutionComponent("sql", { query: "select id from users where active = 1" }, tui, CWD);
        c.updateResult(result("2 rows"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("plan renders input as markdown", () => {
        const c = new ToolExecutionComponent("plan", { plan: "# Plan\n\n1. read\n2. edit" }, tui, CWD);
        c.updateResult(result("ok"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("streaming write input tail", () => {
        const c = new ToolExecutionComponent("write", {}, tui, CWD);
        c.updateStreamingInput({ path: "/repo/src/new.ts", content: "line1\nline2\nline3" });
        expect(c.render(W)).toMatchSnapshot();
    });
});

describe("special message boxes", () => {
    test("skill invocation collapsed and expanded", () => {
        const block = parseSkillBlock('<skill name="verify" location="/repo/.skills/verify.md">\ncheck it\n</skill>');
        const c = new SkillInvocationMessageComponent(block!);
        expect(c.render(W)).toMatchSnapshot();
        c.setExpanded(true);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("compaction summary collapsed and expanded", () => {
        const c = new CompactionSummaryMessageComponent({ summary: "We fixed auth.", tokensBefore: 123456 });
        expect(c.render(W)).toMatchSnapshot();
        c.setExpanded(true);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("branch summary collapsed", () => {
        expect(new BranchSummaryMessageComponent("Abandoned branch did X.").render(W)).toMatchSnapshot();
    });

    test("dynamic border", () => {
        expect(new DynamicBorder().render(20)).toMatchSnapshot();
    });
});

describe("chat history end-to-end", () => {
    test("a small conversation renders stably", () => {
        const h = new ChatHistory(tui, CWD);
        h.addUser("run the tests");
        h.appendAssistantDelta("Running them now.", "anthropic", "claude");
        h.addToolCall("bash", "c1", { command: "bun test" });
        h.addToolResult("c1", "12 pass");
        h.appendAssistantDelta("All green.", "anthropic", "claude");
        h.finishAssistant();
        h.addSystem("model switched");
        h.addCommand("/model sonnet");
        h.addHook("post-turn hook ran");
        h.addError("boom");
        h.addRecap("Fixed the tests.");
        h.addCompactionSummary("Old context.", 5000, 1751980000000);
        h.addBranchSummary("Side quest.");
        expect(h.render(W)).toMatchSnapshot();
    });

    test("skill user message + session-start hook context", () => {
        const h = new ChatHistory(tui, CWD);
        h.addUser('<skill name="verify" location="/x">\nbody\n</skill>\n\ndo it');
        expect(h.render(W)).toMatchSnapshot();
    });

    test("tools expanded toggle re-renders expanded", () => {
        const h = new ChatHistory(tui, CWD);
        h.addUser("go");
        h.addToolCall("bash", "c1", { command: "seq 12" });
        h.addToolResult("c1", Array.from({ length: 12 }, (_, i) => String(i + 1)).join("\n"));
        h.setToolsExpanded(true);
        expect(h.render(W)).toMatchSnapshot();
    });
});
