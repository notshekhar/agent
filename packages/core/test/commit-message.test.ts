import { describe, expect, test } from "bun:test";

import { cleanSubject, trimDiffForPrompt } from "../src/agent/commit-message";

describe("trimming a diff for the prompt", () => {
    test("leaves a normal diff alone", () => {
        const diff = "diff --git a/a.ts b/a.ts\n+const x = 1;\n";
        expect(trimDiffForPrompt(diff)).toBe(diff);
    });

    test("keeps every file's name when one file is enormous", () => {
        // The real case: a lockfile next to the change you actually made. Paying
        // to read 200KB of lockfile is the waste; losing the other filenames is
        // the bug, because those are what the subject line should describe.
        const huge = `diff --git a/bun.lock b/bun.lock\n${"+dependency\n".repeat(30_000)}`;
        const small = "diff --git a/src/feature.ts b/src/feature.ts\n+export const x = 1;\n";

        const trimmed = trimDiffForPrompt(huge + small);

        expect(trimmed).toContain("a/src/feature.ts");
        expect(trimmed).toContain("export const x = 1;");
        expect(trimmed).toContain("file truncated");
        expect(trimmed.length).toBeLessThan(30_000);
    });

    test("caps the total even when every file is individually small", () => {
        const many = Array.from(
            { length: 400 },
            (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n+line\n`,
        ).join("");
        expect(trimDiffForPrompt(many).length).toBeLessThanOrEqual(24_100);
    });
});

describe("cleaning the model's subject line", () => {
    test("takes the first non-empty line only", () => {
        expect(cleanSubject("\n\nAdd the widget\n\nSome rambling body\n")).toBe("Add the widget");
    });

    test("strips the dressing models add", () => {
        expect(cleanSubject('"Add the widget"')).toBe("Add the widget");
        expect(cleanSubject("'Add the widget'")).toBe("Add the widget");
        expect(cleanSubject("`Add the widget`")).toBe("Add the widget");
        expect(cleanSubject("- Add the widget")).toBe("Add the widget");
        expect(cleanSubject("* Add the widget")).toBe("Add the widget");
        expect(cleanSubject("Add the widget.")).toBe("Add the widget");
    });

    test("leaves an apostrophe inside the subject alone", () => {
        // Only a matching *pair* of wrapping quotes is dressing.
        expect(cleanSubject("Don't crash on empty input")).toBe("Don't crash on empty input");
    });
});
