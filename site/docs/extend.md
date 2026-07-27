<!-- title: Extending -->
<!-- order: 7 -->
<!-- blurb: MCP servers, JS extensions, Claude Code-compatible hooks, custom agents, and the bash sandbox. -->

## MCP servers

Model Context Protocol servers add their tools to the agent's toolset automatically. Both stdio (local process) and http/sse (remote) transports work, with OAuth where the server wants it.

```
loop mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ~/code
loop mcp add --transport http docs https://code.claude.com/docs/mcp
loop mcp add --transport http figma https://mcp.figma.com/mcp --oauth
loop mcp add --transport sse linear https://mcp.linear.app/sse \
  --header "Authorization: Bearer ${env:LINEAR_TOKEN}"
```

| Command                             | What                          |
| ----------------------------------- | ----------------------------- |
| `loop mcp list`                     | Configured servers            |
| `loop mcp get <name>`               | One server's config           |
| `loop mcp remove <name>`            | Remove it                     |
| `loop mcp enable\|disable <name>`   | Toggle without removing       |
| `loop mcp login <name>`             | Run the OAuth browser sign-in |
| `loop mcp add-json <name> '<json>'` | Add from a raw JSON config    |

Options for `add`: `--transport/-t <stdio\|http\|sse>`, `--scope/-s <user\|project>`, `--header/-H "Name: Value"` (repeatable), `--env/-e KEY=VALUE` (repeatable), `--oauth`, `--client-id`, `--client-secret`, `--oauth-scopes a,b,c`.

`${env:VAR}` placeholders in headers resolve from your environment at connect time, so tokens stay out of the config file. Project-scoped servers live in `<repo>/.loop/mcp.json`; user-scoped ones in `~/.loop`. `/mcp` manages all of it from the TUI.

## Extensions

JS extensions can add tools, slash commands, providers, status-line segments, and tool/turn middleware.

```
loop install <spec>       # install an extension
loop extensions           # list installed ones
loop link                 # develop one from a local folder
```

`/extensions` toggles them from the TUI. They live in `~/.loop/extensions/`.

## Hooks

Lifecycle hooks run shell commands with a JSON payload on stdin at points like `PreToolUse`, `PostToolUse`, `SessionStart`, and `Stop`.

They are **Claude Code-compatible**: hooks and plugins from `~/.claude/settings.json` and `.claude/` are imported automatically, so switching costs you nothing. Filter what gets imported with the `claudeHooksFilter` setting.

- `/hooks` manages loop-owned hooks.
- Project hooks live in `<repo>/.loop/settings.json`.
- The first time you open a repo that ships hooks or skills, loop asks for **project trust** before anything executes.

## Custom agents

`/agents` builds an agent with its own system prompt, tool allowlist, and optionally a pinned model. It registers as a slash command:

```
/reviewer look at the auth changes
```

Agents are markdown files in `~/.loop/agents/*.md` — the same directory also overrides the built-in agents' prompts if you drop a file with a built-in's name.

## Skills and prompts

- `*.md` in `~/.loop/agent/skills/` or `<repo>/.loop/skills/` — registered as `/skill:<name>`, and invokable by the model itself through the `skill` tool when a task matches the skill's description.
- `*.md` in `~/.loop/agent/prompts/` — plain slash commands.

## The bash sandbox

`bash` can run each command inside an OS-enforced sandbox, so the model's shell access is bounded by the kernel rather than by trust. Configure it under `sandbox` in `settings.json`:

| Key                        | What                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| `enabled`                  | Turn the sandbox on                                                        |
| `network`                  | `"deny"` (default) blocks outbound network                                 |
| `allowWrite` / `denyWrite` | Filesystem write boundaries (the working directory is writable by default) |
| `allowRead` / `denyRead`   | Read boundaries (everything outside cwd is read-only unless allowed)       |
| `allowGitConfig`           | Let commands read your git config                                          |

It is **fail-open** for the normal case: if the boundary can't be applied on your platform, the command still runs but loop appends a `[loop sandbox] … ran WITHOUT isolation` warning. Never a silent downgrade.

The read-only `plan` agent is the exception — it's **fail-closed**. Its bash runs read-only and network-denied, and is refused outright if that can't be enforced.

## The bash denylist

Before anything runs, `bash` checks the command against `bashDeny` and refuses a match. It resolves each command to its real name and subcommand, looking past wrappers (`sudo`, `env`, `nohup`, `time`, `xargs`, …), `sh -c "…"` scripts, and `$(…)` substitutions, and normalizes full paths to basenames (`/bin/rm` → `rm`). Patterns match by name (`rm`) or name + subcommand prefix (`git commit`).

Defaults to `git commit` and `git push` — commits and pushes stay with the human. Override the list in `settings.json` or manage it with `/bashdeny`.

> This is a **guardrail, not a security boundary**. String inspection is fundamentally bypassable (base64-pipe-to-sh, write-a-script-then-run-it). It reliably stops honest, ordinary invocations; the sandbox above is what stops the rest.

## Programmatic use

```
loop rpc                  # JSON-RPC over stdio
loop rpc --socket         # …over a Unix socket
loop rpc stop             # end the socket daemon
loop serve --port 4000    # web UI + WebSocket RPC (opt-in via /settings, token-locked)
```

The same RPC surface is what the Telegram bridge and web UI are built on, so anything they do, you can do.
