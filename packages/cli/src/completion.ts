/**
 * Shell tab completion for the `loop` command.
 *
 * The command and flag tables live in spec.ts — the same data the parser
 * validates against — so a new subcommand is described once rather than in
 * three shell dialects that drift apart from what the CLI actually accepts.
 * The generated scripts are static text: completion must not shell out to
 * `loop` on every Tab, which would put a process spawn (and a cold config
 * read) in front of a keystroke.
 */
import { PRODUCT_NAME } from "@notshekhar/loop-core";
import { COMMANDS, FLAG_SPECS, GLOBAL_FLAGS, INTERACTIVE_FLAGS, type CommandSpec } from "./spec";

export const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SUPPORTED_SHELLS)[number];

export { COMMANDS };

/** Commands worth offering at the first word — aliases stay out of the list. */
const listedCommands = (): CommandSpec[] => COMMANDS.filter((c) => !c.hidden);

/** Flags offered before or instead of a command: what bare `loop` accepts. */
export const FLAGS: { flag: string; description: string }[] = [...INTERACTIVE_FLAGS, ...GLOBAL_FLAGS].map((name) => ({
    flag: `--${name}`,
    description: FLAG_SPECS[name].description,
}));

/** Value-taking flags, which must complete a value rather than another flag. */
const valueFlags = (): string[] =>
    Object.values(FLAG_SPECS)
        .filter((f) => f.takesValue)
        .map((f) => `--${f.name}`);

/**
 * What may follow a command: its subcommands and its own flags. Offering the
 * per-command flags is the reason completion reads the parser's table — the
 * shell now suggests exactly the set the parser will accept, so `--max-steps`
 * completes after `run` and nowhere else.
 */
const commandWords = (c: CommandSpec): string[] => [
    ...(c.subcommands ?? []),
    ...(c.flags ?? []).map((f) => `--${f}`),
    // --help is worth offering everywhere; --version after a command is
    // accepted but meaningless, so it stays out of the suggestions.
    "--help",
];

/** Commands that have anything of their own to offer at the second word. */
const commandsWithWords = (): CommandSpec[] => listedCommands().filter((c) => c.subcommands?.length || c.flags?.length);

const commandNames = (): string =>
    listedCommands()
        .map((c) => c.name)
        .join(" ");
const flagNames = (): string => FLAGS.map((f) => f.flag).join(" ");

/** Escape for a single-quoted POSIX shell string. */
const qq = (s: string): string => s.replace(/'/g, `'\\''`);

function bashScript(name: string): string {
    // A case over the first word: `loop gateways <Tab>` completes that command's
    // subcommands and flags, anything else completes the command list plus flags.
    const cases = commandsWithWords()
        .map((c) => `        ${c.name}) COMPREPLY=($(compgen -W '${commandWords(c).join(" ")}' -- "$cur")); return;;`)
        .join("\n");
    // --cwd wants a directory; every other value flag has nothing we can offer.
    const opaque = valueFlags()
        .filter((f) => f !== "--cwd")
        .join("|");
    return `# ${name} completion for bash
_${name}_complete() {
    local cur prev
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    # Flags that take a value: let the shell complete paths, not our words.
    case "$prev" in
        --cwd) COMPREPLY=($(compgen -d -- "$cur")); return;;
        ${opaque}) return;;
    esac

    # Second word onward: complete the command's own subcommands and flags.
    if [ "$COMP_CWORD" -gt 1 ]; then
        case "\${COMP_WORDS[1]}" in
${cases}
        esac
    fi

    COMPREPLY=($(compgen -W '${commandNames()} ${flagNames()}' -- "$cur"))
}
complete -F _${name}_complete ${name}
`;
}

function zshScript(name: string): string {
    // zsh shows the description beside each candidate, which is the whole
    // reason to emit a native script instead of reusing bashcompinit.
    const described = listedCommands()
        .map((c) => `        '${c.name}:${qq(c.description)}'`)
        .join("\n");
    const flagLines = FLAGS.map((f) => `        '${f.flag}:${qq(f.description)}'`).join("\n");
    // compadd rather than _values: the word lists now contain --flags, and
    // `_values 'tag' --flag` would read the leading -- as its own terminator.
    const subCases = commandsWithWords()
        .map((c) => `        ${c.name}) compadd -- ${commandWords(c).join(" ")} ;;`)
        .join("\n");
    return `#compdef ${name}
# ${name} completion for zsh

_${name}() {
    local -a commands flags
    commands=(
${described}
    )
    flags=(
${flagLines}
    )

    if (( CURRENT == 2 )); then
        _describe -t commands 'command' commands
        _describe -t flags 'flag' flags
        return
    fi

    case "\${words[2]}" in
${subCases}
        *) _files ;;
    esac
}

_${name} "$@"
`;
}

function fishScript(name: string): string {
    const lines: string[] = [`# ${name} completion for fish`];
    // No file completion by default: the first word is a command, not a path.
    lines.push(`complete -c ${name} -f`);
    for (const c of listedCommands()) {
        lines.push(`complete -c ${name} -n '__fish_use_subcommand' -a '${c.name}' -d '${qq(c.description)}'`);
        for (const sub of c.subcommands ?? []) {
            lines.push(`complete -c ${name} -n '__fish_seen_subcommand_from ${c.name}' -a '${sub}'`);
        }
        // The command's own flags, offered only once that command is on the line.
        for (const f of c.flags ?? []) {
            const spec = FLAG_SPECS[f];
            lines.push(
                `complete -c ${name} -n '__fish_seen_subcommand_from ${c.name}' -l '${f}' -d '${qq(spec.description)}'`,
            );
        }
    }
    for (const f of FLAGS) {
        lines.push(`complete -c ${name} -l '${f.flag.replace(/^--/, "")}' -d '${qq(f.description)}'`);
    }
    return lines.join("\n") + "\n";
}

export function completionScript(shell: Shell, name: string = PRODUCT_NAME): string {
    switch (shell) {
        case "bash":
            return bashScript(name);
        case "zsh":
            return zshScript(name);
        case "fish":
            return fishScript(name);
    }
}

/** Where each shell wants the script, and how to load it — printed to stderr so
 * `loop completion zsh > file` still yields a clean file. */
export function installHint(shell: Shell, name: string = PRODUCT_NAME): string {
    switch (shell) {
        case "bash":
            return `# add to ~/.bashrc:\n#   source <(${name} completion bash)`;
        case "zsh":
            // A #compdef script must live on fpath; sourcing it directly works
            // only if compinit has already run, which is the usual footgun.
            return (
                `# write it somewhere on your fpath, then restart the shell:\n` +
                `#   ${name} completion zsh > "\${fpath[1]}/_${name}"\n` +
                `# or add to ~/.zshrc (after compinit):\n` +
                `#   source <(${name} completion zsh)`
            );
        case "fish":
            return `# write it once:\n#   ${name} completion fish > ~/.config/fish/completions/${name}.fish`;
    }
}
