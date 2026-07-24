# Security Policy

This document explains the security model behind loop and where its boundaries
are.

loop is a coding agent that runs locally, within the security boundary of the
user account running it. It reads and writes files, runs shell commands, and
talks to model providers on that user's behalf. It is the user's responsibility
to monitor what it does, or to contain it in a container, virtual machine, or
other sandbox.

loop treats the local user account and every file writable by that account as
inside the same trust boundary as the loop process itself. If an attacker can
modify files under the user's home directory, workspace, shell startup files,
environment, or loop's own configuration in `~/.loop`, they can generally
influence loop or any other local developer tool. Reports that depend on that
prior local write access are not security vulnerabilities unless they show how
loop itself grants that access or crosses an operating-system privilege
boundary.

loop relies on users working in repositories they trust, and installing
extensions, skills, and MCP servers they trust. Files like `AGENTS.md`,
`CLAUDE.md`, or instructions hidden in source comments can prompt-inject a
coding agent trivially, and that cannot be defended against in general.

## Remote surfaces

Two features let something outside the local machine reach the agent. Both are
off by default and must be turned on deliberately, and both hand the remote side
the same shell access loop already has:

- **`loop serve`** exposes a JSON-RPC/WebSocket API and a web UI, protected by a
  bearer token. Anyone with the token can drive the agent. It is intended for
  `localhost` or a trusted private network; exposing it to the public internet
  is not a supported configuration.
- **Gateways** (`/gateways`, e.g. the Telegram bridge) pair loop to a chat.
  Whoever controls the paired chat runs shell commands as you. Pairing is
  therefore one-shot, locked to a single chat, and can only be set up from the
  machine itself.

Vulnerabilities in the authentication, pairing, or session-isolation logic of
these surfaces are in scope. Their intended behavior — that an authenticated
client or the paired chat can run commands — is not.

## Reporting a Vulnerability

If you believe you have found a security vulnerability in loop, please report it
privately by either:

- Opening a private report through GitHub Security Advisories on
  <https://github.com/notshekhar/loop>, or
- Emailing `shekhar@oboe.chat`

Please include:

- A description of the issue and its impact
- Steps to reproduce, a proof of concept, or relevant logs
- Affected package, version, commit, or configuration
- Any known mitigations

Do not open a public issue for security-sensitive reports. Reports will be
reviewed and disclosure coordinated as appropriate.

## Scope

Security issues in the published packages and release binaries, the command-line
tool, the `loop serve` API and web UI, the gateway bridges, and this
repository's code are in scope.

## Out Of Scope

- Local code execution or sandboxing behavior — loop intentionally has no
  sandbox of its own
- Behavior of extensions, skills, MCP servers, or hooks installed or configured
  by the user
- Risks from working in untrusted repositories
- Risks from installing untrusted extensions, skills, packages, or tools
- Issues caused by untrustworthy MITM proxies or custom provider endpoints
- Public internet exposure of a `loop serve` instance or a gateway
- Prompt injection attacks
- Exposed secrets that are third-party or user-controlled credentials, including
  the provider API keys and OAuth tokens stored in `~/.loop/auth.json`
- Reports requiring the ability to create, modify, delete, or replace files,
  directories, symlinks, environment variables, shell configuration, or other
  user-controlled local state on the target machine. This includes `~/.loop`,
  its session database and settings, workspace files, `AGENTS.md`, `CLAUDE.md`,
  skills, extensions, extension configuration, MCP server definitions, hooks,
  dotfiles, and files synchronized through NFS, roaming profiles, or dotfile
  managers — unless the report shows how loop itself grants that access
- Issues caused by intentionally weakened user configuration, including
  permission rules that allow a tool without prompting
- Resource or denial-of-service claims that require trusted local input or
  configuration
- Reports about malicious model output
- User-approved or user-initiated local actions presented as vulnerabilities

## Notes for Reporters

The most useful reports show a current, reproducible security boundary bypass
with demonstrated impact. Reports that only show expected local-agent behavior,
prompt injection, or a malicious trusted extension or skill are not security
vulnerabilities under this model.

For example, a report showing that malicious contents written to a trusted loop
configuration file cause loop to execute commands, load attacker-controlled
tools, send credentials to an attacker-controlled endpoint, or otherwise change
behavior is out of scope.

When possible, include the exact affected path, package version or commit SHA,
configuration, and a proof of concept against the latest release or the latest
`main`. For dependency reports, include evidence that the shipped dependency is
affected and that the issue is reachable through loop.
