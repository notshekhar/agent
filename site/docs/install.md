<!-- title: Installing -->
<!-- order: 2 -->
<!-- blurb: One-line installers for macOS, Linux, WSL, and Windows — plus updating, uninstalling, and building from source. -->

loop ships as a prebuilt, bun-compiled binary. There is no Node requirement, no `npm install`, and no build step.

## macOS / Linux / WSL

```
curl -fsSL https://raw.githubusercontent.com/notshekhar/loop/main/install.sh | bash
```

The installer downloads the latest release tarball for your platform, verifies its sha256, runs the binary once to confirm it actually works on your machine, and symlinks `loop` (and the `agent` alias) into `/usr/local/bin` or `~/.local/bin`. If that directory isn't on your `PATH`, it prints the exact line to add for your shell.

Prebuilt targets: `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `windows-x64`.

On musl distros (Alpine), the installer stops and points you at `gcompat` or a source build instead of leaving you with a binary that won't start.

### Environment knobs

| Variable           | Effect                                            |
| ------------------ | ------------------------------------------------- |
| `LOOP_VERSION`     | Pin a specific release tag instead of latest      |
| `LOOP_FORCE`       | Reinstall even if the same version is present     |
| `LOOP_FROM_SOURCE` | Build from source instead of downloading a binary |
| `LOOP_HOME`        | Where loop's files live (default `~/.loop`)       |
| `LOOP_BIN_DIR`     | Where the symlink goes                            |
| `LOOP_UNINSTALL=1` | Clean removal — keeps your `~/.loop` config       |

## Windows

PowerShell:

```
irm https://raw.githubusercontent.com/notshekhar/loop/main/install.ps1 | iex
```

cmd.exe (bootstraps PowerShell for you):

```
curl -fsSLo %TEMP%\loop-install.cmd https://raw.githubusercontent.com/notshekhar/loop/main/install.cmd && %TEMP%\loop-install.cmd
```

Installs to `%USERPROFILE%\.loop-bin\loop.exe` and adds it to your user `PATH` **and the current session**, so `loop` works immediately — no new terminal needed.

Windows on ARM gets the x64 build, which runs under Windows 11's emulation.

First run shows a SmartScreen prompt: click **More info** → **Run anyway**. That's an unsigned-binary warning, not a detection.

Knobs: `$env:LOOP_VERSION`, `$env:LOOP_FORCE`, `$env:LOOP_HOME`, `$env:LOOP_UNINSTALL = '1'`.

## Verify

```
loop version
loop doctor
```

`loop` on its own starts the TUI. If the command isn't found, the installer's PATH line didn't get applied — open a new shell or add it to your profile.

## Updating

`/update` inside the TUI, or:

```
loop upgrade
```

Both check the latest release and run the platform installer in place. Self-update works while loop is running, Windows included.

The TUI also tells you at startup when a newer release is out. Silence that with `LOOP_SKIP_VERSION_CHECK=1`.

## Uninstalling

```
LOOP_UNINSTALL=1 curl -fsSL https://raw.githubusercontent.com/notshekhar/loop/main/install.sh | bash
```

PowerShell:

```
$env:LOOP_UNINSTALL = '1'; irm https://raw.githubusercontent.com/notshekhar/loop/main/install.ps1 | iex
```

Both remove the binary and leave `~/.loop` alone — your sessions, cost history, and credentials survive. Delete that directory yourself if you want a clean slate.

## From source

Needs [bun](https://bun.sh) ≥ 1.2.

```
git clone https://github.com/notshekhar/loop.git
cd loop
bun install
bun run build
bun run link
```

`bun run link` builds the CLI and links it so `loop` on your PATH is your working copy. During development, `bun run dev` runs the TUI straight from source.

## In CI

There's a GitHub Action:

```
- uses: actions/checkout@v4
- uses: notshekhar/loop@v0
  with:
      prompt: "Review the changes in this checkout and summarize bugs and risks."
      model: anthropic/claude-sonnet-4-6
      post-comment: "true"
  env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`prompt` and `model` are required; `model` must be fully qualified (`provider/model`). Other inputs: `version`, `working-directory`, `max-steps` (default `40`), `post-comment`, `github-token`. The agent's reply is exposed as the `response` output and appended to the job summary.

Provider credentials come from the caller's environment, so there's no `loop login` step in CI — see [environment variables](login.html#environment-variables). `post-comment: "true"` needs `pull-requests: write`. Linux and macOS runners only.

Next: [sign in to a provider](login.html).
