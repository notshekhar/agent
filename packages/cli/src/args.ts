import { readFileSync } from "node:fs";
import { allowedFlags, findCommand, FLAG_SPECS, flagForShort, suggestCommand, suggestFlag } from "./spec";

export interface Args {
    cmd?: string;
    positional: string[];
    flags: Record<string, string | boolean>;
    /**
     * Usage problems found while parsing. Non-empty means the invocation was
     * not understood — cli.ts prints these and exits 1 rather than running
     * something adjacent to what was asked for.
     */
    errors: string[];
}

/**
 * A short flag we don't have, that people type anyway, and what to say instead.
 * `-p` is the reflex from other agent CLIs; here the one-shot mode is a
 * command, so the fix is a different word rather than a different flag.
 */
const SHORT_FLAG_HINTS: Record<string, string> = {
    p: 'one-shot mode is a command here: loop run "<prompt>"',
};

/**
 * Parse argv into a command, positionals and flags — rejecting what it does
 * not recognize.
 *
 * The rejection is the point. Flag arity comes from FLAG_SPECS, so a boolean
 * flag no longer eats the token after it; unknown flags and unknown commands
 * become errors instead of being kept (and silently ignored later) or falling
 * through to the interactive TUI.
 *
 * `--` ends flag parsing, and a lone `-` stays positional — it is `loop run`'s
 * read-the-prompt-from-stdin marker.
 */
export function parseArgs(argv: string[]): Args {
    const out: Args = { positional: [], flags: {}, errors: [] };
    /** Flag names as written, for the per-command check after the loop. */
    const seen: string[] = [];
    let unknownCommand: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];

        if (a === "--") {
            out.positional.push(...argv.slice(i + 1));
            break;
        }

        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
            const inline = eq > 0 ? a.slice(eq + 1) : undefined;
            const spec = FLAG_SPECS[name];
            seen.push(name);
            if (!spec) {
                // Arity is unknown, so don't guess at consuming the next token;
                // the error stops the run before the value would matter.
                out.flags[name] = inline ?? true;
                continue;
            }
            if (!spec.takesValue) {
                if (inline !== undefined) out.errors.push(`--${name} is a switch and takes no value`);
                out.flags[name] = true;
                continue;
            }
            if (inline !== undefined) {
                out.flags[name] = inline;
                checkChoice(out, spec, inline);
                continue;
            }
            const next = argv[i + 1];
            // A lone `-` is a real value (stdin); anything else dash-led is the
            // next flag, which means this one was left dangling.
            if (next === undefined || (next.startsWith("-") && next !== "-")) {
                out.errors.push(`--${name} needs a value — ${spec.description.toLowerCase()}`);
                out.flags[name] = true;
                continue;
            }
            out.flags[name] = next;
            checkChoice(out, spec, next);
            i++;
            continue;
        }

        // A lone `-` is the stdin marker, not a flag.
        if (a.startsWith("-") && a !== "-") {
            for (const letter of a.slice(1)) {
                const spec = flagForShort(letter);
                if (!spec) {
                    const hint = SHORT_FLAG_HINTS[letter];
                    out.errors.push(`unknown flag -${letter}${hint ? ` — ${hint}` : ""}`);
                    continue;
                }
                // Stored under the long name only — one flag, one key, so no
                // reader has to check both spellings.
                seen.push(spec.name);
                out.flags[spec.name] = true;
            }
            continue;
        }

        // First bare token is the command — after flag values have been
        // consumed, so `loop --model x run "hi"` still dispatches `run`.
        if (out.cmd === undefined && out.positional.length === 0) {
            out.cmd = a;
            const spec = findCommand(a);
            if (!spec) {
                unknownCommand = a;
            } else if (spec.passthrough) {
                // The command runs its own parser (mcp) — hand the tail over
                // verbatim instead of judging flags this table never listed.
                out.positional.push(...argv.slice(i + 1));
                break;
            }
            continue;
        }

        out.positional.push(a);
    }

    if (unknownCommand !== undefined) {
        out.errors.push(unknownCommandError(unknownCommand));
        // Flags can't be judged without knowing the command; one error is
        // enough to send the user to `loop help`.
        return out;
    }

    const allowed = allowedFlags(findCommand(out.cmd ?? ""));
    for (const name of seen) {
        if (allowed.has(name)) continue;
        const suggestion = suggestFlag(name, allowed);
        const where = out.cmd ? `\`${out.cmd}\`` : "interactive mode";
        // A real flag used on the wrong command reads differently from a typo,
        // and saying which it is saves a trip to --help.
        const known = name in FLAG_SPECS;
        out.errors.push(
            known
                ? `--${name} is not a flag of ${where}` + (suggestion ? ` (did you mean --${suggestion}?)` : "")
                : `unknown flag --${name}` + (suggestion ? ` — did you mean --${suggestion}?` : ""),
        );
    }
    return out;
}

/** Reject a value outside a flag's fixed set, naming the set. */
function checkChoice(out: Args, spec: { name: string; choices?: readonly string[] }, value: string): void {
    if (!spec.choices || spec.choices.includes(value)) return;
    out.errors.push(`--${spec.name} must be one of: ${spec.choices.join(", ")} (got ${JSON.stringify(value)})`);
}

/** The unknown-command message, including the "you meant to run a prompt" case. */
function unknownCommandError(word: string): string {
    // A sentence in command position is someone reaching for one-shot mode.
    // It used to open the TUI and drop the text on the floor.
    if (/\s/.test(word)) return `unknown command ${JSON.stringify(word)} — to run a prompt: loop run "${word}"`;
    const suggestion = suggestCommand(word);
    return `unknown command ${JSON.stringify(word)}` + (suggestion ? ` — did you mean \`${suggestion}\`?` : "");
}

/** Read stdin to EOF — `loop run -` takes its prompt piped (CI, long diffs). */
export async function readStdinAll(): Promise<string> {
    // Read the fd directly when stdin isn't a tty: in the bundled build the
    // process.stdin stream sees EOF without data for regular-file stdin
    // (`loop run - < file`), while pipes only survive by arrival timing (#5).
    // A tty keeps the stream path so interactive typing + Ctrl+D still works.
    if (!process.stdin.isTTY) {
        try {
            return readFileSync(0, "utf8");
        } catch {
            // Non-blocking or otherwise unreadable fd — fall back to the stream.
        }
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

export async function readStdinLine(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        const onData = (chunk: string) => {
            data += chunk;
            const nl = data.indexOf("\n");
            if (nl >= 0) {
                process.stdin.off("data", onData);
                process.stdin.pause();
                resolve(data.slice(0, nl).trim());
            }
        };
        process.stdin.resume();
        process.stdin.on("data", onData);
    });
}
