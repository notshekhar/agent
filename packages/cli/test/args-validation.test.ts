/**
 * The parser's rejection rules. Before these existed, `loop sesions` opened an
 * interactive chat, `--modle gpt-5` ran a whole turn on the default model, and
 * a boolean flag ate the token after it. Each test below is one of those.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { allowedFlags, COMMANDS, FLAG_SPECS, findCommand, suggestCommand } from "../src/spec";

describe("unknown input is rejected, not reinterpreted", () => {
    test("an unknown command errors instead of falling through to the TUI", () => {
        const args = parseArgs(["sesions"]);
        expect(args.errors).toHaveLength(1);
        expect(args.errors[0]).toContain('unknown command "sesions"');
        expect(args.errors[0]).toContain("sessions");
    });

    test("a sentence in command position points at run, which is what was meant", () => {
        // This used to open the TUI and drop the prompt on the floor.
        const args = parseArgs(["fix the bug"]);
        expect(args.errors[0]).toContain('loop run "fix the bug"');
    });

    test("an unknown long flag errors and suggests the near miss", () => {
        const args = parseArgs(["run", "--modle", "gpt-5", "prompt"]);
        expect(args.errors).toHaveLength(1);
        expect(args.errors[0]).toBe("unknown flag --modle — did you mean --model?");
    });

    test("an unknown short flag errors rather than becoming part of the prompt", () => {
        // `-p` used to land in positional, so the prompt became "-p hello".
        const args = parseArgs(["run", "-p", "hello"]);
        expect(args.errors[0]).toContain("unknown flag -p");
        expect(args.errors[0]).toContain('loop run "<prompt>"');
    });

    test("a real flag on the wrong command says so, rather than being ignored", () => {
        const args = parseArgs(["sessions", "--model", "x"]);
        expect(args.errors[0]).toBe("--model is not a flag of `sessions`");
    });

    test("a value flag left dangling is an error, not a silent `true`", () => {
        expect(parseArgs(["run", "--model"]).errors[0]).toContain("--model needs a value");
        expect(parseArgs(["run", "--model", "--cwd", "/tmp"]).errors[0]).toContain("--model needs a value");
    });

    test("a switch given a value is an error", () => {
        expect(parseArgs(["sessions", "--all=yes"]).errors[0]).toContain("takes no value");
    });

    test("a value outside a flag's fixed set is rejected, naming the set", () => {
        const args = parseArgs(["run", "--output-format", "yaml", "prompt"]);
        expect(args.errors[0]).toBe('--output-format must be one of: text, json, stream-json (got "yaml")');
        // Same check on the --flag=value spelling.
        expect(parseArgs(["run", "--output-format=yaml"]).errors).toHaveLength(1);
    });

    test("no errors means every flag was understood", () => {
        for (const argv of [
            ["run", "-", "--model", "openai/gpt-5", "--max-steps", "40"],
            ["run", "--output-format", "stream-json", "prompt"],
            ["sessions", "--all"],
            ["serve", "--host", "127.0.0.1", "--port", "8080"],
            ["goals", "add", "text", "--every", "2h", "--cwd", "/tmp"],
            ["man", "--install"],
            ["upgrade", "--force"],
            ["--help"],
            ["-v"],
        ]) {
            expect({ argv, errors: parseArgs(argv).errors }).toEqual({ argv, errors: [] });
        }
    });
});

describe("flag arity comes from the table", () => {
    test("a boolean flag does not swallow the token after it", () => {
        // The old parser consumed any non---prefixed token as the value.
        const args = parseArgs(["sessions", "--all", "extra"]);
        expect(args.flags.all).toBe(true);
        expect(args.positional).toEqual(["extra"]);
    });

    test("a short flag is stored under its long name only", () => {
        expect(parseArgs(["-v"]).flags).toEqual({ version: true });
        expect(parseArgs(["-h"]).flags).toEqual({ help: true });
    });

    test("bundled short flags each resolve", () => {
        expect(parseArgs(["-vh"]).flags).toEqual({ version: true, help: true });
    });
});

describe("positional handling", () => {
    test("a lone - stays positional (the stdin prompt marker)", () => {
        const args = parseArgs(["run", "-", "--model", "anthropic/claude-fable-5"]);
        expect(args.positional).toEqual(["-"]);
        expect(args.errors).toEqual([]);
    });

    test("-- ends flag parsing so a prompt may start with dashes", () => {
        const args = parseArgs(["run", "--", "--model", "is literally the prompt"]);
        expect(args.positional).toEqual(["--model", "is literally the prompt"]);
        expect(args.errors).toEqual([]);
    });

    test("flags may precede the command", () => {
        // The old parser only read a command from argv[0], so this dispatched
        // the TUI and left "run" sitting in positional.
        const args = parseArgs(["--model", "openai/gpt-5", "run", "hi"]);
        expect(args.cmd).toBe("run");
        expect(args.positional).toEqual(["hi"]);
        expect(args.errors).toEqual([]);
    });

    test("a passthrough command hands its tail over unjudged", () => {
        // mcp runs its own parser; flags this table never listed are its business.
        const args = parseArgs(["mcp", "add", "--transport", "sse", "--header=x:1"]);
        expect(args.errors).toEqual([]);
        expect(args.positional).toEqual(["add", "--transport", "sse", "--header=x:1"]);
    });
});

describe("the table and the dispatcher agree", () => {
    const cliSource = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");

    test("every command and alias in spec.ts has a case in cli.ts", () => {
        // The failure this prevents is a command that parses cleanly and then
        // does nothing (cli.ts's `default` branch exits 70 saying exactly this).
        const missing: string[] = [];
        for (const c of COMMANDS) {
            for (const name of [c.name, ...(c.aliases ?? [])]) {
                if (!cliSource.includes(`case "${name}":`)) missing.push(name);
            }
        }
        expect(missing).toEqual([]);
    });

    test("every flag a command lists exists in FLAG_SPECS", () => {
        for (const c of COMMANDS) {
            for (const f of c.flags ?? []) {
                expect({ command: c.name, flag: f, known: f in FLAG_SPECS }).toEqual({
                    command: c.name,
                    flag: f,
                    known: true,
                });
            }
        }
    });

    test("every command in the table is documented in `loop help`", async () => {
        // The unknown-command error sends people to `loop help`, so a command
        // missing from it is a dead end.
        const { printHelp } = await import("../src/commands");
        const lines: string[] = [];
        const log = console.log;
        console.log = (s: string) => void lines.push(s);
        try {
            printHelp("0.0.0");
        } finally {
            console.log = log;
        }
        const help = lines.join("\n");
        const missing = COMMANDS.filter((c) => !c.hidden && !new RegExp(`\\b${c.name}\\b`).test(help)).map(
            (c) => c.name,
        );
        expect(missing).toEqual([]);
    });

    test("aliases resolve to their command", () => {
        expect(findCommand("background")?.name).toBe("goals");
        expect(findCommand("update")?.name).toBe("upgrade");
        expect(findCommand("telegram")?.name).toBe("gateways");
        expect(findCommand("uninstall")?.name).toBe("remove");
    });

    test("globals are accepted everywhere, including with no command", () => {
        expect(allowedFlags(undefined).has("help")).toBe(true);
        expect(allowedFlags(findCommand("run")).has("help")).toBe(true);
        // Bare `loop` still takes the session-shaping flags.
        expect(allowedFlags(undefined).has("model")).toBe(true);
    });
});

describe("suggestions stay useful", () => {
    test("near misses resolve", () => {
        expect(suggestCommand("sesions")).toBe("sessions");
        expect(suggestCommand("mdoels")).toBe("models");
        expect(suggestCommand("sess")).toBe("sessions");
    });

    test("a word with nothing in common suggests nothing", () => {
        // Better silence than "did you mean run?" for an unrelated word.
        expect(suggestCommand("kubernetes")).toBeUndefined();
    });
});
