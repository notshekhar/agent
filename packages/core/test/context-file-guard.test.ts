import { describe, expect, test } from "bun:test";
import { findContextFileDeletion, formatContextFileRefusal } from "../src/tools/utils/context-file-guard";

describe("findContextFileDeletion", () => {
    test("catches rm of CLAUDE.md", () => {
        expect(findContextFileDeletion("rm CLAUDE.md")).toEqual({ command: "rm", file: "CLAUDE.md" });
    });

    test("catches rm -f with a path prefix", () => {
        expect(findContextFileDeletion("rm -f docs/CLAUDE.md")).toEqual({ command: "rm", file: "CLAUDE.md" });
    });

    test("catches the mv migration to AGENTS.md", () => {
        expect(findContextFileDeletion("mv CLAUDE.md AGENTS.md")).toEqual({ command: "mv", file: "CLAUDE.md" });
    });

    test("catches git rm", () => {
        expect(findContextFileDeletion("git rm -f AGENTS.md")).toEqual({ command: "git rm", file: "AGENTS.md" });
    });

    test("catches git mv", () => {
        expect(findContextFileDeletion("git mv CLAUDE.md AGENTS.md")).toEqual({ command: "git mv", file: "CLAUDE.md" });
    });

    test("catches a deletion hidden in a chained command", () => {
        expect(findContextFileDeletion("ls && rm CLAUDE.md")).toEqual({ command: "rm", file: "CLAUDE.md" });
    });

    test("catches a wrapped deletion (sudo /bin/rm)", () => {
        expect(findContextFileDeletion("sudo /bin/rm CLAUDE.md")).toEqual({ command: "rm", file: "CLAUDE.md" });
    });

    test("matches case-insensitively", () => {
        expect(findContextFileDeletion("rm claude.md")).toEqual({ command: "rm", file: "claude.md" });
    });

    test("ignores rm of other files", () => {
        expect(findContextFileDeletion("rm -rf node_modules README.md")).toBeNull();
    });

    test("ignores reads and edits of context files", () => {
        expect(findContextFileDeletion("cat CLAUDE.md")).toBeNull();
        expect(findContextFileDeletion("grep tabs AGENTS.md")).toBeNull();
    });

    test("ignores git checkout/status touching context files", () => {
        expect(findContextFileDeletion("git checkout CLAUDE.md")).toBeNull();
    });

    test("names the file in the refusal", () => {
        const hit = findContextFileDeletion("rm CLAUDE.md");
        expect(hit).not.toBeNull();
        expect(formatContextFileRefusal(hit!)).toContain("CLAUDE.md");
    });
});
