import { describe, expect, test } from "bun:test";
import { printResumeHint } from "../src/interactive/resume-hint";

/** A stdout stand-in that records what was written and whether it's a TTY. */
function fakeOut(isTTY: boolean) {
    const chunks: string[] = [];
    return {
        isTTY,
        write: (s: string) => {
            chunks.push(s);
            return true;
        },
        get text() {
            return chunks.join("");
        },
    } as unknown as NodeJS.WriteStream & { text: string };
}

describe("resume hint", () => {
    test("prints a command that can be pasted back", () => {
        const out = fakeOut(true);
        printResumeHint("019ff7c0-2255-7ce0-85b8-9edf57bdd030", out);
        expect(out.text).toContain("Resume this session with:");
        expect(out.text).toContain("loop --session 019ff7c0-2255-7ce0-85b8-9edf57bdd030");
    });

    test("says nothing when there is no session to resume", () => {
        // An unsaved conversation has no id; printing a command that cannot
        // work is worse than printing nothing.
        const out = fakeOut(true);
        printResumeHint(undefined, out);
        expect(out.text).toBe("");
    });

    test("says nothing when stdout is not a terminal", () => {
        // The line is for a human reading their scrollback, never for a pipe.
        const out = fakeOut(false);
        printResumeHint("abc", out);
        expect(out.text).toBe("");
    });
});
