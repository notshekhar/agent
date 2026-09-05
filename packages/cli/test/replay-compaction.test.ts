import { beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

// Pin the color pipeline before the theme module reads COLORTERM.
process.env.COLORTERM = "truecolor";

import type { Session } from "@notshekhar/loop-core";
import { renderSessionBranch } from "../src/interactive/replay";
import { ChatHistory } from "../src/interactive/components/chat-history";
import { initTheme } from "../src/interactive/ui/theme";

beforeAll(() => initTheme("dark"));

const tui = { requestRender() {} } as unknown as TUI;

const fakeSession = (id: string, entries: unknown[]): Session =>
    ({ id, getBranch: () => entries }) as unknown as Session;

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

const renderText = (entries: unknown[]): string => {
    const history = new ChatHistory(tui, "/repo");
    renderSessionBranch(fakeSession("compaction-test", entries), history, "xai/grok-4.5");
    return strip(history.render(120).join("\n"));
};

/**
 * A compaction removes entries from the MODEL's context, not from the session.
 * Replay used to skip them, so reopening a compacted thread showed only the
 * summary and the survivors while /tree and both web surfaces still listed
 * everything — the same session read as two different conversations.
 */
describe("renderSessionBranch across a compaction", () => {
    // cutAt counts MESSAGE entries only, and the compact entry is appended when
    // compaction runs — so it sits later on the branch than the cut it records.
    const entries = [
        { type: "message", role: "user", content: "PRE_CUT_REQUEST", ts: 1, id: "u1", parentId: null },
        { type: "message", role: "assistant", content: "PRE_CUT_REPLY", ts: 2, id: "a1", parentId: "u1" },
        { type: "message", role: "user", content: "KEPT_REQUEST", ts: 3, id: "u2", parentId: "a1" },
        { type: "message", role: "assistant", content: "KEPT_REPLY", ts: 4, id: "a2", parentId: "u2" },
        {
            type: "compact",
            summary: "SUMMARY_BODY",
            cutAt: 2,
            tokensBefore: 21_388,
            tokensAfter: 900,
            ts: 5,
            id: "c1",
            parentId: "a2",
        },
    ];

    test("renders entries the compaction cut from model context", () => {
        const out = renderText(entries);
        expect(out).toContain("PRE_CUT_REQUEST");
        expect(out).toContain("PRE_CUT_REPLY");
        expect(out).toContain("KEPT_REQUEST");
        expect(out).toContain("KEPT_REPLY");
    });

    test("the compaction marker sits at the cut, not at the compact entry", () => {
        const out = renderText(entries);
        const preCut = out.indexOf("PRE_CUT_REPLY");
        const marker = out.indexOf("21,388");
        const kept = out.indexOf("KEPT_REQUEST");
        // Guard the ordering assertions: a missing pre-cut message makes
        // indexOf return -1, which would satisfy them vacuously.
        expect(preCut).toBeGreaterThan(-1);
        expect(marker).toBeGreaterThan(-1);
        expect(marker).toBeGreaterThan(preCut);
        // The four surviving messages sit between cutAt and the compact entry's
        // own position; drawing the marker there would put messages the model
        // CAN see above their own boundary.
        expect(marker).toBeLessThan(kept);
    });

    test("a session with no compaction renders no marker", () => {
        const out = renderText([
            { type: "message", role: "user", content: "PLAIN_REQUEST", ts: 1, id: "u1", parentId: null },
        ]);
        expect(out).toContain("PLAIN_REQUEST");
        expect(out).not.toContain("Compacted from");
    });

    test("a cut past every message still draws its marker once", () => {
        const out = renderText([
            { type: "message", role: "user", content: "ONLY_REQUEST", ts: 1, id: "u1", parentId: null },
            {
                type: "compact",
                summary: "S",
                cutAt: 9,
                tokensBefore: 1000,
                tokensAfter: 10,
                ts: 2,
                id: "c1",
                parentId: "u1",
            },
        ]);
        expect(out).toContain("ONLY_REQUEST");
        expect(out.match(/Compacted from/g)?.length).toBe(1);
    });
});
