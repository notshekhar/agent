import { describe, expect, test } from "bun:test";
import { COMMANDS } from "../src/completion";
import { manInstallPath, manPageSource } from "../src/manpage";

const page = () => manPageSource("loop", "1.2.3");

describe("man page", () => {
    test("opens with a .TH header carrying name, section and version", () => {
        expect(page().startsWith('.TH LOOP 1 "')).toBe(true);
        expect(page()).toContain("loop 1.2.3");
    });

    test("has the sections man readers navigate by", () => {
        for (const section of ["NAME", "SYNOPSIS", "DESCRIPTION", "COMMANDS", "OPTIONS", "FILES", "EXAMPLES"]) {
            expect(page()).toContain(`.SH ${section}`);
        }
    });

    test("documents every command the CLI dispatches", () => {
        // Same table as completion, so the manual can't describe a different
        // CLI than the one Tab completes.
        for (const c of COMMANDS) expect(page()).toContain(`.B loop ${c.name}`);
    });

    test("SYNOPSIS uses one .RI per bracket group", () => {
        // .RI alternates roman/italic per argument: a single
        // ".RI [ command ] [ options ]" renders as "[_c_o_m_m_a_n_d]_[options_]".
        expect(page()).toContain(".RI [ command ]\n.RI [ options ]");
        expect(page()).not.toContain(".RI [ command ] [ options ]");
    });

    test("the NAME line is escaped the way man expects", () => {
        // `-` must be `\-` in roff or it renders as a typographic hyphen.
        expect(page()).toContain("loop \\- terminal coding agent");
    });

    test("no line starts with a bare dot that isn't a roff request", () => {
        for (const line of page().split("\n")) {
            if (!line.startsWith(".")) continue;
            // Every dot-line must be a known request, else roff swallows it.
            expect(line).toMatch(/^\.(TH|SH|TP|PP|B|I|BR|RI|RB|IR|br|nf|fi|\\&)/);
        }
    });

    test("installs to a directory on the default user manpath", () => {
        expect(manInstallPath("loop")).toMatch(/\.local\/share\/man\/man1\/loop\.1$/);
    });

    test("the product name is threaded through, not hardcoded", () => {
        const renamed = manPageSource("banana", "1.0.0");
        expect(renamed).toContain(".TH BANANA 1");
        expect(renamed).toContain("banana \\- terminal coding agent");
        expect(renamed).not.toContain("loop");
    });
});
