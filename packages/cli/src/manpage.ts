/**
 * The `loop(1)` man page, generated from the same command table that drives
 * shell completion so the two can't describe different CLIs.
 *
 * `loop man` renders it through the system pager via `man`, and
 * `loop man --path` prints the file so an installer can drop it on the
 * MANPATH — that is what makes plain `man loop` work.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { COMMANDS, commandsForFlag, FLAG_SPECS } from "./spec";

/** roff needs a leading dot escaped, or the line is read as a request. */
const roffEscape = (s: string): string => s.replace(/\\/g, "\\\\").replace(/^\./gm, "\\&.").replace(/-/g, "\\-");

export function manPageSource(name: string, version: string): string {
    const upper = name.toUpperCase();
    const date = new Date().toISOString().slice(0, 10);
    const lines: string[] = [
        `.TH ${upper} 1 "${date}" "${name} ${version}" "User Commands"`,
        ".SH NAME",
        `${roffEscape(name)} \\- terminal coding agent`,
        ".SH SYNOPSIS",
        `.B ${name}`,
        // One .RI per bracket group: .RI alternates roman/italic per argument,
        // so a single ".RI [ command ] [ options ]" italicises the wrong halves.
        ".RI [ command ]",
        ".RI [ options ]",
        ".SH DESCRIPTION",
        `Run ${roffEscape(name)} with no arguments to open the interactive TUI in the current`,
        "directory. With a command, it performs that task and exits.",
        ".PP",
        "The agent reads and writes files, runs shell commands, and calls model",
        "providers on your behalf, inside your own user account. It has no sandbox of",
        `its own \\(em see SECURITY.md in the repository for the trust boundary.`,
        ".SH COMMANDS",
    ];
    for (const c of COMMANDS) {
        lines.push(".TP");
        const args = c.subcommands?.length ? ` \\fI${c.subcommands.join("\\fR|\\fI")}\\fR` : "";
        lines.push(`.B ${name} ${c.name}${args}`);
        // Aliases are dispatched but not listed as their own commands, so the
        // man page is the one place that has to name them.
        const aka = c.aliases?.length ? ` (also: ${c.aliases.join(", ")})` : "";
        lines.push(roffEscape(c.description + aka));
    }
    lines.push(".SH OPTIONS");
    // Every flag, not just the global ones: each command accepts only its own,
    // so the man page has to say which is which.
    for (const f of Object.values(FLAG_SPECS)) {
        lines.push(".TP");
        const short = f.short ? `, \\-${f.short}` : "";
        const value = f.takesValue ? " \\fIvalue\\fR" : "";
        lines.push(`.B \\-\\-${roffEscape(f.name)}${short}${value}`);
        const owners = commandsForFlag(f.name);
        const where = owners.length ? ` [${owners.join(", ")}]` : "";
        lines.push(roffEscape(f.description + where));
    }
    lines.push(
        ".SH FILES",
        ".TP",
        `.I ~/.${name}/settings.json`,
        "Global settings: default model, hooks, MCP servers, toggles.",
        ".TP",
        `.I ~/.${name}/auth.json`,
        "Provider credentials and custom provider definitions.",
        ".TP",
        `.I <cwd>/.${name}/settings.json`,
        "Project settings, overriding the global file.",
        ".TP",
        ".I AGENTS.md, CLAUDE.md",
        "Workspace context files, read into the agent's prompt.",
        ".SH ENVIRONMENT",
        ".TP",
        ".B <PROVIDER>_API_KEY",
        "Provider API keys are read from the environment when not stored by",
        `.BR ${name} " login" .`,
        ".SH EXAMPLES",
        ".TP",
        `.B ${name}`,
        "Open the interactive agent in the current directory.",
        ".TP",
        `.B ${name} run "explain this repo"`,
        "Run one prompt and exit.",
        ".TP",
        `.B ${name} completion zsh > "\${fpath[1]}/_${name}"`,
        "Install shell tab completion.",
        ".SH SEE ALSO",
        `Full documentation at https://github.com/notshekhar/${name}`,
    );
    return lines.join("\n") + "\n";
}

/** Where the page is written so `man loop` finds it without configuration:
 * ~/.local/share/man is on the default manpath on macOS and most Linux. */
export function manInstallPath(name: string): string {
    return join(homedir(), ".local", "share", "man", "man1", `${name}.1`);
}

/** Write the page to the user manpath. Returns the path written. */
export function installManPage(name: string, version: string): string {
    const path = manInstallPath(name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, manPageSource(name, version));
    return path;
}

/**
 * Show the page now. Renders through `man` so it gets the pager, hyphenation,
 * and terminal width the user expects; falls back to the raw source when no
 * `man` exists (Windows, stripped containers).
 */
export function showManPage(name: string, version: string): void {
    const path = installManPage(name, version);
    const r = spawnSync("man", [path], { stdio: "inherit" });
    if (r.error) {
        console.log(manPageSource(name, version));
    }
}
