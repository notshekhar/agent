# Configuring {{name}}

How to add models, custom providers, hooks, MCP servers, and custom agents.
Read the relevant section in full before editing anything, then make the edit,
then tell the user to **hard-reload** (see below) so it takes effect.

## Where config lives

| What                                                         | File                          |
| ------------------------------------------------------------ | ----------------------------- |
| Global settings (default model, hooks, MCP servers, toggles) | `~/{{dir}}/settings.json`     |
| Auth + custom providers (API keys, OAuth creds, gateways)    | `~/{{dir}}/auth.json`         |
| Custom agents                                                | `~/{{dir}}/agents/<name>.md`  |
| Project settings / hooks (override global)                   | `<cwd>/{{dir}}/settings.json` |
| Project MCP servers (override global)                        | `<cwd>/{{dir}}/mcp.json`      |

All config files are plain JSON — edit them with the normal edit/write tools.
Unknown keys are preserved, so only touch the keys you mean to change. Always
read the existing file first (the edit tool requires it) and keep valid JSON.

Boolean toggles live at the top level of `~/{{dir}}/settings.json` and can also
be flipped via `/settings`. Example: `"askUser": true` enables the `ask` tool,
which lets the agent pause mid-turn and ask you multiple-choice questions
(default off; interactive TUI only — never offered in print mode).

Other notable keys (all managed via `/settings` too):

- `"subagentModel"` — default model for subagents (full `provider/model` id,
  cross-provider allowed). An agent file's own `model:` wins over it; unset =
  subagents inherit the parent's model. Invalid/unavailable picks fall back to
  the parent model with a visible warning.
- `"bashApprove": true` — ask before every bash command (deny / allow once /
  always allow), like a permission prompt. Default off; interactive TUI only.
- `"bashAllow"` — the "always allow" list the approval prompt maintains
  (same `command` / `"command subcommand"` pattern shape as `bashDeny`). A
  command runs unprompted only when every segment matches an entry.

## Hard reload — REQUIRED after any config change

Config is read into memory at startup. After you edit any file above, the change
does **not** apply to the running session. Tell the user to either:

- run **`/reload`** (re-reads settings, theme, commands, agents, hooks, models), or
- **quit and restart** {{name}}.

End every config task by telling the user which one to do.

---

## Add a model from a built-in provider

Built-in providers: `anthropic`, `openai`, `google`, `xai`, `openrouter`,
`github-copilot`, `deepseek`, `mistral`, `glm`, `zai`, `groq`, `cerebras`,
`zenmux`, `bedrock`, `ollama`.

Their models are discovered automatically once the provider is authenticated —
there is no per-model list to maintain. Two providers need no login at all:
`ollama` (detected local daemon) and `bedrock` (AWS credentials from the aws
CLI / env / SSO; the model list comes from the account's Bedrock access —
region via `AWS_REGION` or `{{env}}_BEDROCK_REGION`). The flow is:

1. Authenticate: the user runs `{{name}} login <provider>` (or `/login`). API keys
   and OAuth creds are stored in `~/{{dir}}/auth.json`; do not hand-write secrets
   into it unless the user asks.
2. Pick the model live with `/model`, or pin a default in `~/{{dir}}/settings.json`:

```json
{
    "defaultModel": "anthropic/claude-opus-4-8"
}
```

Model ids are always `"<provider>/<model>"`. Per-project model memory is
automatic: the last model picked with `/model` in a folder is restored next
time {{name}} starts there (stored in {{name}}'s internal database, not in
settings.json — there is no key to edit for it).

If the user wants a model that isn't on a built-in provider (a gateway, a
self-hosted endpoint, a proxy), that's a **custom provider** — see below.

---

## Add a custom provider (and its models)

Custom providers are gateways or OpenAI/Anthropic/Google-compatible endpoints
(bifrost, litellm, a self-hosted proxy, etc.). They live in `~/{{dir}}/auth.json`
under `customProviders`, keyed by name. Their models are referenced as
`"custom:<name>/<model>"`.

Shape (`CustomProviderConfig`):

```json
{
    "customProviders": {
        "bifrost": {
            "name": "bifrost",
            "sdk": "anthropic",
            "baseURL": "https://gateway.example.com",
            "apiKey": "sk-...",
            "headers": { "x-team": "platform" },
            "models": [
                {
                    "id": "claude-opus-4-8",
                    "name": "Opus via bifrost",
                    "contextWindow": 200000,
                    "maxOutput": 64000,
                    "cost": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 }
                }
            ]
        }
    }
}
```

- `sdk` — the API dialect the endpoint speaks: `"openai"`, `"anthropic"`,
  `"google"`, or `"openai-compatible"`. This decides request shaping (e.g.
  Anthropic prompt caching). Pick the one matching the endpoint.
- `baseURL` — root URL. The version segment (`/v1`, `/v1beta`) is appended
  automatically when missing, so a bare host is fine.
- `apiKey` — gateway key (use a placeholder if the endpoint needs none).
- `headers` — optional extra headers sent on every request.
- `models` — optional. If the endpoint supports listing, {{name}} can discover
  models; list them here to control exactly what's exposed plus names/pricing.
  Adding a model to an existing custom provider = appending to this array.

Select the model with `/model` (it appears as `custom:bifrost/claude-opus-4-8`)
or pin it: `"defaultModel": "custom:bifrost/claude-opus-4-8"`.

---

## Add a hook

Hooks are Claude-Code-compatible lifecycle commands under the `hooks` key.
Global hooks go in `~/{{dir}}/settings.json`; project hooks in
`<cwd>/{{dir}}/settings.json` (project groups run after global groups).

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Notification`, `PermissionRequest`, `PreCompact`, `SubagentStop`, `Stop`,
`SessionEnd`.

Shape — each event maps to matcher groups; each group has `hooks` (command list):

```json
{
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "bash",
                "hooks": [{ "type": "command", "command": "./scripts/check.sh", "timeout": 60 }]
            }
        ],
        "Stop": [
            {
                "hooks": [{ "type": "command", "command": "notify-send '{{name}} done'", "async": true }]
            }
        ]
    }
}
```

- `matcher` — for tool events, the tool name to match (e.g. `"bash"`, `"edit"`).
  Omit to match everything.
- `command` — shell command. It receives a JSON payload on stdin (cwd,
  `hook_event_name`, `tool_name`, `tool_input`, `tool_output`, `prompt`, …).
- `timeout` — seconds (default 60). `async: true` = fire-and-forget.
- Exit code contract: `0` → stdout parsed as JSON for control fields
  (`decision`, `permissionDecision`, `updatedInput`, `additionalContext`,
  `systemMessage`); `2` → block, stderr is the reason; any other → non-blocking
  warning.

Existing Claude Code hook scripts port over 1:1.

---

## Add an MCP server

MCP servers are declared under `mcpServers` in `~/{{dir}}/settings.json` (global),
or per-project in `<cwd>/{{dir}}/mcp.json` (project entries win on name clash).
The project file accepts either `{ "mcpServers": { ... } }` or a bare map.

Two transports:

**stdio** (local subprocess):

```json
{
    "mcpServers": {
        "filesystem": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
            "env": { "FOO": "bar" }
        }
    }
}
```

**http / sse** (remote):

```json
{
    "mcpServers": {
        "linear": {
            "type": "http",
            "url": "https://mcp.linear.app/mcp",
            "headers": { "Authorization": "Bearer ${env:LINEAR_TOKEN}" },
            "auth": "oauth"
        }
    }
}
```

- `enabled: false` keeps the entry but skips connecting.
- `auth: "oauth"` runs the browser login flow; omit it for static-header auth.
- Secrets: use `${env:VAR}` in any string value (resolved from the environment)
  so tokens stay out of plaintext config. For servers that block anonymous
  client registration, set `clientId` / `clientSecret` / `scopes`.
- MCP has a master switch: `"mcp": false` disables all servers.

---

## Create a custom agent

Custom agents are named system prompts at `~/{{dir}}/agents/<name>.md`. Each file
registers a `/<name>` slash command. The name must start alphanumeric and be
≤32 chars of `[a-z0-9_-]` (case-insensitive).

Format — optional frontmatter with `tools:` and/or `model:` lines, then the
prompt body:

```markdown
---
tools: read, grep, find, ls
model: openai/gpt-5-mini
---

You are a meticulous code reviewer. You investigate and report; you never edit.
```

- `tools:` — comma-separated subset of: `read, write, edit, bash, ls, grep,
find, sql, task`. Omit the frontmatter entirely to grant all tools.
- `model:` — full `provider/model` id this agent runs on when spawned as a
  subagent (task tool). Cross-provider is fine. Omit = inherit (the
  `subagentModel` setting if set, else the parent's model). If the id is
  unknown or its provider isn't logged in, the run falls back to the parent's
  model with a warning instead of failing.
- No frontmatter = full toolset, inherited model.
- Built-in names (`default`, `plan`, `data-analyst`) are special: saving a file
  under one of those names overrides only its **prompt** and **model** — their
  tool sets are fixed and ignored. Delete the file to reset.
- An agent that has `bash` but neither `write` nor `edit` runs bash read-only
  (sandboxed) — useful for review/plan-style agents.

Write the file with the write tool, then have the user hard-reload so the new
`/<name>` command appears.
