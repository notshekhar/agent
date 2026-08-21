/**
 * Session titles. The generator itself needs a provider, so what is pinned
 * here is the part that runs on every model's output no matter how badly it
 * behaves: a title has to survive being put in a terminal tab.
 */
import { describe, expect, test } from "bun:test";
import { cleanTitle } from "../src/agent/session-title";

describe("cleanTitle", () => {
    test("strips the decoration models add unasked", () => {
        expect(cleanTitle('**"Fix the flaky pty test."**')).toBe("Fix the flaky pty test");
        expect(cleanTitle("`Add cmux status reporting`")).toBe("Add cmux status reporting");
        expect(cleanTitle("# Refactor the parser")).toBe("Refactor the parser");
    });

    test("keeps a title to one line", () => {
        // A model that explains itself would otherwise put its reasoning in
        // the terminal's title bar — and a newline in an OSC sequence ends it.
        expect(cleanTitle("Fix the pty test\n\nThis title covers the work described above.")).toBe("Fix the pty test");
        expect(cleanTitle("\n\n  Add session titles  \n")).toBe("Add session titles");
    });

    test("elides at a word boundary, not mid-word", () => {
        const long = "Add loop awareness to the cmux terminal integration everywhere";
        const out = cleanTitle(long);
        expect(out.length).toBeLessThanOrEqual(49); // 48 + the ellipsis
        expect(out.endsWith("…")).toBe(true);
        expect(out).toBe("Add loop awareness to the cmux terminal…");
        // What survives is whole words, so it still reads as a name.
        expect(long.startsWith(out.slice(0, -1))).toBe(true);
    });

    test("a title that already fits is left exactly alone", () => {
        expect(cleanTitle("Fix cmux loop status reporter")).toBe("Fix cmux loop status reporter");
    });

    test("nothing in, nothing out", () => {
        expect(cleanTitle("")).toBe("");
        expect(cleanTitle("\n \n")).toBe("");
    });
});
