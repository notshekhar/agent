<!-- title: Getting started -->
<!-- order: 1 -->
<!-- blurb: Install loop, sign in to a model provider, and run your first session. -->

Install it, give it a model, and start talking to it. Two commands and about a minute.

## Install

macOS, Linux, or WSL:

```
curl -fsSL https://raw.githubusercontent.com/notshekhar/loop/main/install.sh | bash
```

Windows PowerShell:

```
irm https://raw.githubusercontent.com/notshekhar/loop/main/install.ps1 | iex
```

These drop a prebuilt binary — no Node, no build step. Full details, other platforms, and updating are in [Installing](install.html).

## Sign in

loop has no models of its own. It runs whatever you point it at: a subscription you already pay for, an API key, or a model running locally on your machine.

```
loop login
```

That opens a provider picker. The three cheapest ways to start:

- **Already pay for SuperGrok?** `loop login xai` → pick OAuth. Browser sign-in, no key to paste, billed to your plan.
- **Already pay for GitHub Copilot or ChatGPT?** `loop login github-copilot` or `loop login openai` → pick the subscription option.
- **Want to pay nothing?** Run [Ollama](https://ollama.com) locally. loop detects the daemon and lists your local models with no login at all.

Otherwise paste an API key. [Signing in](login.html) has the console URL for every provider and what each key is called.

## Run it

```
cd ~/code/your-project
loop
```

That's the TUI. Type what you want in plain English; loop reads files, edits them, runs commands, and shows you diffs as it goes.

```
loop run "explain what this repo does"
```

That's one-shot mode — a single prompt, printed to stdout, no UI. Good for scripts and CI.

## The first five minutes

| Do this                  | What happens                                                               |
| ------------------------ | -------------------------------------------------------------------------- |
| `/help`                  | Every slash command, searchable                                            |
| `/model`                 | Switch model — any provider you're signed in to                            |
| `/init`                  | loop reads the repo and writes an `AGENTS.md` so it knows your conventions |
| `Tab` on an empty prompt | Cycle agents: default → plan (read-only) → data-analyst                    |
| `Esc`                    | Interrupt the turn in progress                                             |
| `/tree`                  | Navigate the session as a tree and branch from any earlier message         |

Messages typed while the agent is working are queued and run when the turn ends — you don't have to wait for a prompt.

## Where to go next

- [Installing](install.html) — every platform, updating, building from source
- [Signing in](login.html) — every provider, where to get each API key, custom gateways
- [Daily use](usage.html) — sessions, the session tree, models, agents
- [Telegram](telegram.html) — drive loop from your phone
- [Automation](automation.html) — background tasks, goals, scheduled runs
- [Extending](extend.html) — MCP servers, hooks, custom agents, extensions
- [Configuration](configuration.html) — what lives in `~/.loop`, settings, adding models
- [Troubleshooting](troubleshooting.html) — when something doesn't work

## What loop actually is

An open-source terminal coding agent. One TUI in front of 15+ model providers, with a few things that aren't standard:

- **Sessions are trees, not transcripts.** Branch from any earlier message and keep both paths. Abandoned branches get summarized back into context instead of thrown away.
- **Background tasks run detached**, on an OS timer (launchd, systemd, Task Scheduler), so they fire even when loop is closed.
- **Goal mode** drives a session autonomously until an adversarial verifier agrees the objective is met.
- **Claude Code-compatible hooks** — your existing `~/.claude` hooks and plugins load as-is.
- **Remote gateways** — pair a Telegram bot and drive the agent from your phone.
