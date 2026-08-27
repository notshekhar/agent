/**
 * The two modules apps/web ports from here, held to the CLI's behaviour.
 *
 * apps/web is a browser bundle and imports nothing from packages/*, so the
 * verb-group vocabulary and the streaming-input parser exist twice on purpose —
 * each file says "KEEP IN SYNC" at the top. A comment does not keep anything in
 * sync: when background shells shipped, the CLI gained a `shell` verb group and
 * the web copy did not, so the same run of `shells` calls read "Checked 2
 * shells" in the terminal and "Called 2 tools" in the app.
 *
 * Both ports are dependency-free, so this compares them by BEHAVIOUR rather
 * than by text — the copies differ in formatting and in type annotations
 * (apps/web compiles under noUncheckedIndexedAccess), and neither difference
 * means anything.
 */
import { describe, expect, test } from "bun:test";

import * as cliVerbGroup from "../src/interactive/ui/verb-group";
import * as cliStreaming from "../src/interactive/ui/streaming-input";
import * as webVerbGroup from "../../../apps/web/src/components/loop/loopVerbGroup";
import * as webStreaming from "../../../apps/web/src/loop/handlers/streamingInput";

/** Every builtin, plus the shapes the classifier has to handle by rule. */
const TOOL_NAMES = [
    "read",
    "write",
    "edit",
    "bash",
    "shells",
    "ls",
    "tree",
    "glob",
    "grep",
    "find",
    "sql",
    "websearch",
    "webfetch",
    "memory",
    "task",
    "todo",
    "skill",
    "artifact",
    "ask",
    "plan",
    "enter_plan_mode",
    "exit_plan_mode",
    // not ours: an MCP tool (namespaced) and an unknown one
    "sentry__list_errors",
    "some_extension_tool",
];

describe("verb-group parity with the apps/web port", () => {
    test("every tool classifies into the same kind, with the same grammar", () => {
        for (const name of TOOL_NAMES) {
            const cli = cliVerbGroup.kindOf(name);
            const web = webVerbGroup.kindOf(name);
            expect({ name, ...web }).toEqual({ name, ...cli });
        }
    });

    test("the same tools fold, and the same ones are plan surfaces", () => {
        for (const name of TOOL_NAMES) {
            expect({ name, folds: webVerbGroup.foldsEagerly(name) }).toEqual({
                name,
                folds: cliVerbGroup.foldsEagerly(name),
            });
            expect({ name, plan: webVerbGroup.isPlanSurface(name) }).toEqual({
                name,
                plan: cliVerbGroup.isPlanSurface(name),
            });
        }
    });

    test("a run of calls gets the same label", () => {
        const member = (toolName: string, isError = false, isRunning = false): cliVerbGroup.GroupMember => ({
            toolName,
            isError,
            isRunning,
        });
        const runs: cliVerbGroup.GroupMember[][] = [
            [member("read")],
            [member("read"), member("read")],
            [member("shells"), member("shells", true)],
            [member("ls"), member("grep"), member("read")],
            [member("read"), member("read", false, true)],
            [member("sentry__list_errors")],
            [member("some_extension_tool")],
        ];
        for (const members of runs) {
            expect(webVerbGroup.verbGroupLabel(members)).toEqual(cliVerbGroup.verbGroupLabel(members));
        }
    });
});

describe("streaming-input parity with the apps/web port", () => {
    // Every prefix of a real streaming buffer, which is what the parsers see:
    // the chunk almost always ends mid-string, mid-escape, or mid-\u sequence.
    const buffers = [
        String.raw`{"path":"src/index.ts","content":"line one\nline two"}`,
        String.raw`{"path":"a \"quoted\" path.ts","content":"tab\there"}`,
        String.raw`{"content":"é中","path":"unicode.ts"}`,
        String.raw`{"command":"echo hi","timeout":30}`,
        String.raw`{"edits":[{"oldText":"a","newText":"b"},{"oldText":"c","newText":"d"}]}`,
        String.raw`{"edits":[{"newText":"only new"}]}`,
    ];

    test("parsePartialToolInput agrees on every prefix", () => {
        for (const buffer of buffers) {
            for (let i = 0; i <= buffer.length; i++) {
                const prefix = buffer.slice(0, i);
                expect({ prefix, out: webStreaming.parsePartialToolInput(prefix) }).toEqual({
                    prefix,
                    out: cliStreaming.parsePartialToolInput(prefix),
                });
            }
        }
    });

    test("parsePartialEditInput agrees on every prefix", () => {
        for (const buffer of buffers) {
            for (let i = 0; i <= buffer.length; i++) {
                const prefix = buffer.slice(0, i);
                expect({ prefix, out: webStreaming.parsePartialEditInput(prefix) }).toEqual({
                    prefix,
                    out: cliStreaming.parsePartialEditInput(prefix),
                });
            }
        }
    });
});
