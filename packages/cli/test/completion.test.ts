import { describe, expect, test } from "bun:test";
import { COMMANDS, completionScript, FLAGS, installHint, SUPPORTED_SHELLS } from "../src/completion";

describe("completion scripts", () => {
    test("every shell emits a script naming every command", () => {
        for (const shell of SUPPORTED_SHELLS) {
            const script = completionScript(shell, "loop");
            for (const cmd of COMMANDS) {
                expect(script).toContain(cmd.name);
            }
        }
    });

    test("subcommands reach the script, so `loop gateways <Tab>` has something to offer", () => {
        for (const shell of SUPPORTED_SHELLS) {
            const script = completionScript(shell, "loop");
            expect(script).toContain("status");
            expect(script).toContain("add-json");
            expect(script).toContain("daemon");
        }
    });

    test("bash registers a completion function against the real command name", () => {
        const script = completionScript("bash", "loop");
        expect(script).toContain("complete -F _loop_complete loop");
    });

    test("zsh carries the #compdef tag it needs to be picked up from fpath", () => {
        expect(completionScript("zsh", "loop").startsWith("#compdef loop")).toBe(true);
    });

    test("fish disables file completion so the first word offers commands", () => {
        expect(completionScript("fish", "loop")).toContain("complete -c loop -f");
    });

    test("the product name is threaded through rather than hardcoded", () => {
        // loop is rebrandable (brand.ts) — a completion script wired to the old
        // name would silently never fire.
        const script = completionScript("bash", "banana");
        expect(script).toContain("complete -F _banana_complete banana");
        expect(script).not.toContain("loop");
    });

    test("descriptions with apostrophes can't break out of the quoted string", () => {
        // zsh and fish embed descriptions in single quotes.
        for (const shell of ["zsh", "fish"] as const) {
            const script = completionScript(shell, "loop");
            for (const line of script.split("\n")) {
                const quotes = (line.match(/'/g) ?? []).length;
                // Every line must have balanced quoting (escaped ones come in
                // pairs too), or the shell fails to parse the whole file.
                expect(quotes % 2).toBe(0);
            }
        }
    });

    test("install hints name the shell's own load mechanism", () => {
        expect(installHint("bash", "loop")).toContain("bashrc");
        expect(installHint("zsh", "loop")).toContain("fpath");
        expect(installHint("fish", "loop")).toContain("completions/loop.fish");
    });

    test("every documented flag is offered", () => {
        const script = completionScript("bash", "loop");
        for (const f of FLAGS) expect(script).toContain(f.flag);
    });
});
