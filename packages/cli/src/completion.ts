/**
 * Shell tab completion for the `loop` command.
 *
 * One table of commands, subcommands, and flags drives bash, zsh, and fish, so
 * a new subcommand is described once rather than in three dialects that drift
 * apart. The generated scripts are static text — completion must not shell out
 * to `loop` on every Tab, which would put a process spawn (and a cold config
 * read) in front of a keystroke.
 */
import { PRODUCT_NAME } from "@notshekhar/loop-core";

export const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SUPPORTED_SHELLS)[number];

interface CommandSpec {
    name: string;
    description: string;
    /** Fixed words that may follow the command. */
    subcommands?: string[];
}

/** Every command `loop` dispatches, in the order `loop --help` lists them. */
export const COMMANDS: CommandSpec[] = [
    { name: "run", description: "Run a single prompt and exit" },
    { name: "login", description: "Configure provider auth" },
    { name: "logout", description: "Remove provider auth" },
    { name: "sessions", description: "List sessions in the current directory" },
    { name: "models", description: "List available models" },
    { name: "whoami", description: "Show active provider and auth status" },
    { name: "cost", description: "Cost ledger tools", subcommands: ["audit"] },
    {
        name: "goals",
        description: "Manage background tasks",
        subcommands: ["list", "add", "rm", "run", "tick", "daemon"],
    },
    {
        name: "background",
        description: "Manage background tasks (alias of goals)",
        subcommands: ["list", "add", "rm", "run", "tick", "daemon"],
    },
    {
        name: "mcp",
        description: "Manage MCP servers",
        subcommands: ["add", "add-json", "list", "get", "remove", "enable", "disable", "login"],
    },
    { name: "gateways", description: "Run remote chat gateways", subcommands: ["status", "stop", "telegram"] },
    { name: "serve", description: "Web UI + WebSocket RPC" },
    { name: "rpc", description: "JSON-RPC server", subcommands: ["stop"] },
    { name: "install", description: "Install an extension" },
    { name: "link", description: "Link a local extension" },
    { name: "remove", description: "Remove an extension" },
    { name: "extensions", description: "List installed extensions" },
    { name: "enable", description: "Enable an extension" },
    { name: "disable", description: "Disable an extension" },
    { name: "completion", description: "Print a shell completion script", subcommands: [...SUPPORTED_SHELLS] },
    { name: "man", description: "Open the manual" },
    { name: "upgrade", description: "Update to the latest release" },
    { name: "version", description: "Print version" },
    { name: "help", description: "Show help" },
];

/** Flags accepted before or instead of a command. */
export const FLAGS: { flag: string; description: string }[] = [
    { flag: "--model", description: "Override the model (provider/id)" },
    { flag: "--provider", description: "Override the active provider" },
    { flag: "--cwd", description: "Working directory" },
    { flag: "--session", description: "Resume a session by id" },
    { flag: "--max-steps", description: "Cap agent steps in run mode" },
    { flag: "--help", description: "Show help" },
    { flag: "--version", description: "Print version" },
];

const commandNames = (): string => COMMANDS.map((c) => c.name).join(" ");
const flagNames = (): string => FLAGS.map((f) => f.flag).join(" ");

/** Escape for a single-quoted POSIX shell string. */
const qq = (s: string): string => s.replace(/'/g, `'\\''`);

function bashScript(name: string): string {
    // A case over the first word: `loop gateways <Tab>` completes that command's
    // subcommands, anything else completes the command list plus flags.
    const cases = COMMANDS.filter((c) => c.subcommands?.length)
        .map((c) => `        ${c.name}) COMPREPLY=($(compgen -W '${c.subcommands!.join(" ")}' -- "$cur")); return;;`)
        .join("\n");
    return `# ${name} completion for bash
_${name}_complete() {
    local cur prev
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    # Flags that take a value: let the shell complete paths, not our words.
    case "$prev" in
        --cwd) COMPREPLY=($(compgen -d -- "$cur")); return;;
        --model|--provider|--session|--max-steps) return;;
    esac

    # Second word onward: complete the command's own subcommands.
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
    const described = COMMANDS.map((c) => `        '${c.name}:${qq(c.description)}'`).join("\n");
    const flagLines = FLAGS.map((f) => `        '${f.flag}:${qq(f.description)}'`).join("\n");
    const subCases = COMMANDS.filter((c) => c.subcommands?.length)
        .map((c) => `                ${c.name}) _values '${c.name} subcommand' ${c.subcommands!.join(" ")} ;;`)
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
    for (const c of COMMANDS) {
        lines.push(`complete -c ${name} -n '__fish_use_subcommand' -a '${c.name}' -d '${qq(c.description)}'`);
        for (const sub of c.subcommands ?? []) {
            lines.push(`complete -c ${name} -n '__fish_seen_subcommand_from ${c.name}' -a '${sub}'`);
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
