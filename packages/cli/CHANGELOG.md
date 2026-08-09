# Changelog

## [0.16.11] - 2026-08-09

### Fixed

- **A thread no longer goes silent for good when loop's core restarts.** loop tracks event subscribers per connection, so when the desktop app's core exits and is restarted the subscription that belonged to the old one is gone. The recovery for this already existed — the thread view re-attaches whenever the connection reopens — but it could never run in the desktop app: the hook it listens on was hardcoded to do nothing there, and the shell was announcing the restart on a channel that stopped dead at the preload boundary with nothing on the other side. Until the window was reloaded the transcript stayed frozen: turns ran to completion and the chat showed none of it, which is exactly the shape of a chat that "only renders once loop stops". The announcement is now delivered and the reattach happens on its own. Verified by killing the core out from under a live thread: the app reconnects within a second and the next turn streams normally.

## [0.16.10] - 2026-08-09

### Fixed

- **The desktop app's terminal opens your login shell, not always zsh.** It read `$SHELL` to decide, and `$SHELL` is only set when a program is started from a terminal — an app launched from the Dock, Finder or Spotlight inherits launchd's environment, which does not have it. So the packaged app fell through to a hardcoded zsh for everyone, and anyone whose login shell is fish, bash or anything else got the wrong one. It now reads the passwd database, the same source `dscl` reports, which is right however the app was started. An explicitly set `$SHELL` still wins.
- **That shell now starts as a login shell on macOS, so your PATH is really your PATH.** The same empty GUI environment that hides `$SHELL` hides `PATH` too, leaving a pane that started from a bare `/usr/bin:/bin`. zsh only reads `.zprofile` — where Homebrew's `shellenv` and most PATH setup lives — for login shells, so the terminal came up looking correct while missing much of what you had installed. Measured here, it went from 10 PATH entries to 18. This is what VS Code and Terminal.app do, and it is applied only to shells known to accept the flag, so an unusual shell still starts rather than failing on an argument it does not understand.
- **Electron's own variables no longer leak into the terminal.** `ELECTRON_RUN_AS_NODE` makes any Electron binary run as plain node, so inheriting it quietly broke Electron-based tools run from the pane — including loop's own desktop app.

## [0.16.9] - 2026-08-09

### Fixed

- **Terminals in the desktop app stopped opening after a few hundred of them, and said `posix_spawnp failed`.** Nothing was wrong with the spawn. node-pty leaks two `/dev/ptmx` file descriptors on every terminal it starts on macOS — its cleanup loop is written so that in the ordinary case it closes nothing, and the parent's end of the pty is never closed at all — and macOS caps the number of ptys for the whole machine, not per process. So the app quietly consumed ptys until there were none left, and from that point every terminal failed, permanently, until it was restarted. Measured here: 242 terminals to exhaustion against a limit of 511 shared with every other terminal program running. The error message was misleading because node-pty reports that same string for five different failures, including the one that was actually happening — running out of ptys. Upgrading node-pty fixes the leak; 700 terminals now come and go leaving nothing behind.
- **A shell that cannot start says so in the pane instead of failing an IPC call.** The shell is spawned when the terminal panel first reports its size, so a failure surfaced as a rejected `loop:pty.resize` — an error naming an internal method, over a pane that then stayed blank forever while every subsequent resize tried the spawn again. The reason is written into the terminal itself now, the pane settles instead of waiting for a shell that is never coming, and reopening it is what retries.

### Changed

- **The Linux desktop build no longer has to be packaged on Linux.** node-pty publishes prebuilt bindings for Linux as of the version this release moves to, so every platform is now cross-packageable from any machine.
- **The model catalog was refreshed from models.dev** — pricing corrections across several Gemini and Vercel entries, and one model upstream has withdrawn.

## [0.16.7] - 2026-08-09

### Added

- **The browser panel actually opens a browser now.** The renderer paints a `<webview>` per preview tab, but a guest webview is driven from the main process — the embedder only gets a DOM element and a `getWebContentsId()`. That main-process half did not exist, and the renderer refuses to mount a webview until `preview.getPreviewConfig()` resolves, so the panel enabled its Browser tab, accepted a URL, recorded the tab, and created nothing: typing an address did nothing at all, silently. It is implemented, along with the navigation, zoom, reload and screenshot IPC behind it. The bridge is read from `window.loop.preview` rather than `window.desktopBridge`, since exposing the latter would flip `isElectron` and route auth, connection setup and the updater down upstream paths this shell has never had.
- **Comments can be left on rendered markdown, not just on source.** A comment is a line range, and rendered prose has no line numbers — which is why commenting only worked in the source view. The mdast positions survive into hast, so every top-level block now carries the source lines it came from and a selection resolves back to a range.
- **A folder of repositories shows its repositories instead of one enormous diff.** Concatenating every child's patch came to 34 repositories and 17k added lines on a real workspace: past the preview cap, slow to parse, unreadable. The rows come from `numstat` counts alone, with the dirty ones sorted up, and exactly one repository's diff is fetched when its row is opened.
- **Images in the Files panel load.** `assets.createUrl` had nothing behind it — upstream mints a URL against its own HTTP server, which loop does not have — so every workspace image rendered as "Unable to load workspace image". The bytes now come across the preload bridge and are wrapped in a blob URL.
- **`/reload` works in the desktop app, not only the terminal.** loop serves its settings from an in-memory cache and caches the model catalog for the life of the process, so editing `settings.json`, an agent, a skill or an MCP entry on disk stayed invisible until the app was restarted — there was simply no way to pick a config change up. There is now: a `config.reload` RPC re-reads every config surface, rebuilds the command registry from disk, re-fetches the catalog and reconnects MCP, reachable as `/reload` in the composer or "Reload configuration" in the command palette. It reports what it re-read, because a bare "Reloaded" is indistinguishable from a no-op. Note that it refreshes what the app knows without re-deciding what an already-open conversation is running: a thread mid-flight keeps its model, and new threads pick up the new default.
- **Usage moved out of Settings and into the sidebar.** Spend and streak are something you check, not something you configure — a report that changes nothing has no business behind a settings page that takes over the window. `/usage` is its own destination now, opening in the main body with the sidebar still on screen, and `/cost` and `/steak` both find it since those are the terminal's names for its two halves. The old `/settings/usage` path redirects rather than dying, so bookmarks still land.

### Changed

- **Sidebar thread rows are shorter when there is nothing to say.** The third line carries branch, terminal, PR and diff — all of which the worktree/PR workflow fills in and a plain loop thread does not, so a short list of threads was spending 18px per row on an empty strip with two icons parked at its right edge. The line now renders only when it has content, and the provider and remote icons ride along with the title when it doesn't.

### Fixed

- **A folder full of repositories was told it had a detached HEAD.** loop reports such a folder as a repo so the diff surface can span its children, but it has no branch of its own — and `refName: null` reads to the git control as a detached HEAD, so a plain directory that happened to hold checkouts was advised to "create and checkout a refName" when what it actually needed was `git init`. The status now says *why* it is a repo, and the control offers to initialize one.
- **Three source files were invisible to search below their first NUL byte.** `ChatComposer.tsx`, `handlers/preview.ts` and `telegram/render.ts` used raw NUL bytes as key separators inside template literals. grep, ripgrep and git all classify a file containing a NUL as binary and stop at the first one, which silently hid the last 1200 lines of the composer — including its entire slash-command list — from every search. The separators are now written as `\u0000`: identical string at runtime, and the files are text again.

## [0.16.6] - 2026-08-09

### Changed

- **The AI SDK is current again, and the installed tree now matches what loop declares.** `ai` moves to 7.0.58 and all eleven `@ai-sdk/*` providers to their latest — Anthropic, OpenAI, Google, Bedrock, Gateway, Groq, xAI, Mistral, Cerebras, DeepSeek and MCP. The installed packages had drifted further than the manifests implied, so this is as much a resync as an upgrade. Staying current is deliberate: the one time loop fell behind, a field rename inside the SDK broke tool-input streaming quietly and it took weeks to notice, so every release now checks that pair by name before shipping.
- **The model catalog was rebuilt from models.dev** — 728 models across 10 providers, so pricing and context limits reflect what the providers currently publish rather than what they published at the last release.

### Note

- **MCP stays on the `2025-11-25` protocol for now.** The specification's `2026-07-28` revision is a large, deliberately breaking one — it removes the `initialize` handshake, drops protocol-level sessions, and replaces server-initiated requests with a retry-based pattern. loop speaks MCP through the AI SDK's client, which has not yet adopted it, so there is nothing to switch on here. Servers are required to keep supporting existing clients through a twelve-month deprecation window, so connections are unaffected.

## [0.16.5] - 2026-08-09

### Changed

- **Noir has its own ink now, not loop's colours on a darker background.** `loop` mode keeps the classic vivid palette — gold heading, magenta inline span, green block — which is right for a mode drawing on whatever background your terminal happens to have. Noir washes its own canvas, so it can afford one deliberate set: every colour sits at a single lightness and a shared chroma, with hues spread far enough apart to stay distinguishable. Markdown, syntax highlighting, the semantic colours, the `/context` chart and the list bullet all come from it, so a screen reads tonal rather than primary and nothing shouts over its neighbours.
- **Two colours are deliberately louder than the rest.** A heading has to lead its section and an error has to alert, so both carry extra chroma — never extra brightness, which would break the single-lightness rule the set depends on. Every hue is still anchored to what it means: success green, error red, numbers cool. The set is normalised, not arbitrary.
- **The brand blue got the same treatment in noir.** At full chroma it was the one vivid mark on an otherwise tonal screen — as a list bullet, a prompt, or a typed `/command` it read as a mistake. It now sits at the set's lightness, still unmistakably the brand blue.

### Fixed

- **The same missing git identity, one file further along.** The web app's seam test drives the desktop's real git action against a real repo, so it failed on CI for exactly the reason the desktop's own tests did — the code under test spawns its own git and has no identity to use on a fresh runner. Fixed the same way, in the repo's own config. Both suites now pass with no ambient git config at all, which is the condition CI actually runs in.

## [0.16.4] - 2026-08-09

### Changed

- **The charts are themed too, and generate their colours rather than storing them.** `/context`'s category grid carried its own seven hexes, `/steak`'s usage wall was pinned to GitHub's greens, and injected context — session-start hook output, the active agent badge — had an orange of its own. All three now come from the theme. The categorical swatches cycle through seven hues the palette already keeps distinct because each is doing another job elsewhere (heading gold, link blue, type magenta, number cyan, success, error, variable orange), so no theme has to declare chart colours and a custom one gets a matching chart for free. The usage ramp walks the theme's own success colour out of the canvas, which also means it finally reads correctly on a light background — the fixed dark greens used to sit on white looking like four shades of the same square.

### Fixed

- **The desktop app's git tests only passed on a machine that already had a git identity.** They create real repos and commit into them, and while the test helper set an author through its env, the code under test spawns its own git and inherits none of it — so a developer machine quietly fell back on its global `user.email` while a fresh CI runner failed nine tests with "Author identity unknown". Each temp repo now carries the identity in its own config, so the tests bring what they need. They had never actually run on CI before this: the job hung ahead of them.

## [0.16.3] - 2026-08-09

### Changed

- **The CLI now wears the desktop app's colours.** Both halves of loop shipped their own palette and looked like two products. The terminal's themes are now built from the same design tokens the desktop renders with — including the syntax colours, which come from the very `pierre-dark` / `pierre-light` themes the desktop highlights code blocks with — so a diff, a heading, or a failed command reads the same in either place.
- **Not every web value survives the trip to a terminal, and the ones that don't were pulled back rather than copied.** The brand blue drops from full chroma to 0.16 at the same lightness and hue: in the desktop it sits behind a button, in a TUI it lands on borders, bullets, gutters, thinking ladders and the prompt all at once, and at full strength it stops reading as meaningful. The semantics are muted for the same reason — a whole output line in emerald glares in a way a small badge on a white card does not. Loop mode keeps its own tool-box fills exactly as they were, because a hand-picked fill is not something a linear blend reproduces.
- **Themes are now generated, not transcribed.** A theme is ~55 slots, and four of them meant four near-identical tables that drifted the moment one was edited — with every new UI mode copying them again. Each built-in theme is now about twenty primitives, and one derivation builds the slot table from them, so a change to how a slot relates to its palette reaches every theme in every mode at once. The `ThemeJson` shape is untouched as the wire format: custom themes in `~/.loop/agent/themes/` and themes contributed by extensions still load exactly as before, and still fill any slot they omit from the built-in dark theme.
- **Colour stopped leaking around the theme.** `chalk.yellow` and its siblings paint the terminal's own ANSI palette, which has nothing to do with the active theme — so everything reaching for them ignored `/theme` and `/uimode` entirely and stayed on the terminal's defaults. That was most of what is not a chat message: the `theme → day` line confirming a theme change, selector headings like `Settings (type to filter, Esc to close)`, the `search:` prompt, the working spinner, the todo panel, the login flow. All of it resolves through theme slots now, and resolves per render, so switching a theme repaints it live instead of at next launch.
- **The composer follows the theme too.** The rules above and below the input, and the tint on a `/command` as you type it, were hardcoded cyan inside the TUI package. They are theme slots now (`inputBorder`, `inputCommand`), reached through an optional hook on the editor's theme so an embedder that does not theme its composer still gets the highlight it had.
- **Markdown keeps its five colours.** Deriving every markdown slot from the accent flattened a rendered message into one blue: heading, link, inline `code` and bullet all the same. A heading and an inline span now have hues of their own in the palette, so the old spread is back — gold headings, blue links, a magenta inline span, green for a fenced block whose language loop cannot identify, and muted text under a dim gutter for quotes. The magenta is the syntax palette's own type colour, so an inline `Foo` matches the `Foo` in the code block beneath it.
- **The startup banner is a gradient rule instead of a spinning ring.** The pixel-art loop and its animation are gone; identity now sits beside a vertical rule drawn from the theme's own accent, over aligned `version` / `model` / `branch` / `cwd` / `session` rows. `branch` is new. Being static, it also stops costing renders once it has scrolled into scrollback.

### Fixed

- **Three CI runs sat "in progress" for up to two hours each.** A bare `bun test` walks the whole workspace, which since the desktop release includes the web app's suite — and that suite is written for vitest. Under bun it throws on `vi.waitFor` and `vite-plus/test`, then never exits, so the job held its runner until the six-hour timeout rather than failing. The run is scoped to the bun-native packages now, the web app uses its own runner, and both jobs carry a timeout so the next hang costs minutes.
- **`loop-review` had never run.** Not broken — unreachable: it fires on `pull_request`, and this repo's work lands as direct pushes to `main`. It takes a `workflow_dispatch` with a PR number now, and fails on an empty diff instead of spending a model run reviewing nothing.
- Model catalog refreshed from models.dev.

## [0.15.11] - 2026-08-02

### Added

- **A sixth built-in extension, `wayfinder`** — a port of Matt Pocock's [`/wayfinder`](https://www.aihero.dev/skills-wayfinder) skill, for the effort that is too big for one agent session and still wrapped in fog: you can feel the shape of the work but cannot yet write it down as a spec. It charts the effort as a **map** — one issue labelled `wayfinder:map` whose children are **decision tickets** — and then works those tickets one per session until the way to the destination is clear. Every ticket resolves a _decision_, not a slice of a build, so the map is finished when nothing is left to decide before someone goes and builds the thing. Tickets are either HITL (grilling, prototype — resolved in conversation with you) or AFK (research — fired off as parallel subagents), and whatever cannot yet be phrased sharply stays on the map as fog until an answer clears it. `loop enable wayfinder`, then `/wayfinder <a loose idea>` to chart a map or `/wayfinder <map url>` to work the next ticket.
- **It is a command, not a persona — which is why it is built differently from `ponytail` and `caveman`.** Those two shape every turn through `onSystemPrompt`. Wayfinder ships `disable-model-invocation: true` upstream, meaning the model must never reach for it on its own, so it registers a slash command that emits the same `inject-skill` event loop's own `/skill:<name>` commands use: the skill body renders as a skill card and submits as a turn, and nothing about it touches a session you did not ask it to.
- **The skill's missing dependencies are supplied rather than left to fail.** Upstream expects a "Wayfinding operations" doc laid down by a companion setup skill, and calls out to `/grilling`, `/domain-modeling`, `/research` and `/prototype` — none of which exist here, so the skill would have run aground on its first ticket. The extension appends its own operations section instead: **GitHub Issues** through the `gh` CLI (labels, sub-issues, `--add-assignee @me` to claim a ticket, a frontier query for what is takeable), or **local markdown** under `.wayfinder/` when there is no tracker to speak to. `/wayfinder tracker github|markdown|auto` chooses; `auto` probes for a github.com remote and an authenticated `gh` and falls back to markdown when either is missing, because a half-working `gh` fails in the middle of a map rather than up front. The four sibling skills are mapped onto what loop actually has — one-question-at-a-time turns for the human-in-the-loop tickets, the `task` tool for research subagents — and the mapping defers to the real skills if you install them later.

### Changed

- AI SDK packages upgraded (`ai` 7.0.40 → 7.0.48 and every `@ai-sdk/*` provider alongside it). Verified against the checks that exist because of the v7 field rename: the tool-input stream parts still carry `id` and `delta`, and a live run confirms `tool-input-start` arrives with its id before the `tool-call` and the deltas carry bytes — the write/edit live preview is intact.
- Model catalog refreshed from models.dev.

## [0.15.10] - 2026-08-01

### Changed

- **The `lsp` tool asked for a column number, which is the one thing an agent cannot see.** Every position operation — `goToDefinition`, `findReferences`, `hover`, the call hierarchy — required `character`, a 1-based column. But `read` and `grep` report line numbers and nothing else, so supplying a column meant counting characters into a line by eye. A guess that landed a few characters off hit whitespace or a comma and the server answered "No results found", which is indistinguishable from the symbol genuinely having no definition. The tool looked broken rather than mis-aimed, and one such miss is enough for an agent to fall back to text search for the rest of a session — the operations were there, correct, and largely unused. Position operations now take `symbol` instead: the name at that line, whose column is resolved from the line's own text. `lsp({ operation: "findReferences", filePath: "src/agent/turn.ts", line: 142, symbol: "runTurn" })`. Word boundaries are applied only where the symbol's own edges are word characters, so `run` will not match inside `rerun` while `#private` and `foo!` still match at all. `character` is unchanged and still accepted — it is now the way to reach the second occurrence of a name on one line, since the first wins otherwise — and `symbol` takes precedence when both are given.
- **A missed position now says what went wrong.** `["runTurn" is not on line 3, which reads: }]` quotes the line back, so an off-by-one line number corrects itself on the next call instead of being read as an empty result.
- **The tool's description was a list of nine operations and their arguments.** It described the mechanism and never the job, so nothing in it told an agent which question each operation answers or when the answer is worth a call. It now opens with the questions themselves — where is this defined, who uses this, what breaks if I change it, what implements this interface — and names the moments precision is what the task needs: before renaming a symbol, changing a signature, deleting something that looks dead, or tracing how a value flows. `prepareCallHierarchy` is explicitly demoted, since `incomingCalls` and `outgoingCalls` already perform that step themselves and exposing it as a peer only added a choice with no use.
- **The call summary follows the new shape.** A symbol-named position renders as `goToDefinition · src/main.ts:4 greet`, and a call carrying a line but no column no longer degrades to the bare file path.

## [0.15.9] - 2026-07-29

### Fixed

- **Thinking never appeared for OpenAI models reached through a gateway.** `@ai-sdk/openai` decides whether a model reasons by matching its id against a prefix allowlist — `gpt-5`, `o1`, `o3`, `o4-mini` — and gateways such as bifrost and LiteLLM advertise their catalogue with a vendor segment in front, `openai/gpt-5.6-terra`. loop persists the ids a custom provider's `/v1/models` discovery hands back, so the id that reached the SDK stopped starting with `gpt-5` and the allowlist quietly stopped matching. From there the SDK drops the whole `reasoning` block out of the request and files a warning nothing surfaces: the model still thinks, still bills for the reasoning tokens, and returns an encrypted reasoning item with no summary attached — so the pane stays blank and the request looks, from every angle loop could see, like it succeeded. The failure was invisible precisely because nothing errored.
- **The fix is the provider's own escape hatch, not a workaround around it.** `@ai-sdk/openai` documents `forceReasoning` for exactly this case ("useful for 'stealth' reasoning models (e.g. via a custom baseURL)"), so loop now sets it rather than rewriting model ids or second-guessing the gateway's naming. It is gated twice — the catalogue must positively know the model reasons, and the id must actually carry a vendor segment — because forcing the flag onto a model that does not reason earns a 400. Unprefixed ids and first-party OpenAI models therefore send byte-identical requests to before; only the ids that were already broken change. Thinking level is unaffected and, as before, rides across provider and model switches untouched.

## [0.15.8] - 2026-07-28

### Added

- **Seven more language servers install themselves, instead of asking you to.** `clangd`, `zls`, `lua-language-server`, `terraform-ls`, `texlab`, `tinymist` and `jdtls` ship as prebuilt release archives rather than npm packages, so until now they had to already be on your PATH — open a `.c` or `.java` file without them and the `lsp` extension simply had nothing to say. loop now fetches the build for your platform on first use and unpacks it into `~/.loop/servers/`. The previous release drew this line at "downloading a compiler's language server behind your back is worse than saying it isn't there", which was the right instinct aimed at the wrong target: the line is really between a self-contained editor tool and a face of a toolchain you installed on purpose. `rust-analyzer`, `dart`, `julia` and `sourcekit-lsp` are still found and never fetched, because installing our own beside your rustup one buys a version skew you would then have to debug.
- **Nothing is downloaded that your machine could not have run.** `zls` is version-locked to the Zig compiler, so it is only installed if `zig` is already present; `jdtls` needs a Java 21 runtime and is only installed if `java` reports one — a check that costs milliseconds and saves a 28MB download on a machine where the server could never have started. Platform support is decided before any network call, so an architecture upstream doesn't publish for is a quiet "no server" rather than a failed download.
- **`LOOP_DISABLE_LSP_DOWNLOAD=1` turns every install route off.** For an airgapped machine, a locked-down CI image, or simply a preference to manage your own toolchain. Discovery in `node_modules/.bin` and on PATH is unaffected — loop just stops installing anything, including the npm and `go install` routes it already had.
- **You can add downloadable servers yourself.** `~/.loop/servers/servers.json` entries take a `download` block — a release source (a GitHub repository, HashiCorp's build index, or a fixed URL), an asset-name template, and the platform and architecture words that project happens to use. A new `java` runtime covers servers that are an executable jar rather than an executable. See the extensions documentation for a worked example.

### Fixed

- **`jdtls` was launched with a configuration for the wrong architecture.** Recent Eclipse snapshots ship `config_mac_arm` and `config_linux_arm` beside the x86 ones; loop now probes for the architecture-specific directory and falls back to the generic one, rather than handing an Apple Silicon JVM an x86 configuration and watching it fail to load its native components.
- **A slow download mirror was treated as a broken one.** Eclipse serves the jdtls snapshot from mirrors that run at around 120KB/s, so a healthy transfer of it takes about four minutes. Downloads are now bounded by silence rather than by total elapsed time: a connection that stops sending for a minute is abandoned, while one that is merely slow is left alone to finish.

## [0.15.7] - 2026-07-28

### Fixed

- **`lsp workspaceSymbol` refused a directory, which is the natural thing to ask it about.** The operation lists symbols across a whole project, so an agent names the project — `example-ts-snake`, or the repo root — rather than an arbitrary source file inside it. Servers were matched by file extension, a directory has none, and the answer was "no language server available for this file type" even where the project plainly had one. Every other operation worked, so the failure looked arbitrary. A directory target is now resolved by looking inside it: a bounded, breadth-first scan (skipping `node_modules`, `.git`, `dist` and friends) picks one representative file per language and starts those servers, so a polyglot project gets all of them and a huge repo costs no more than a small one. `filePath` is also optional for `workspaceSymbol` now — omitting it means the workspace.
- **`workspaceSymbol` returned nothing from a server that had just started.** A tsserver-style server builds its program from the documents that have been opened, so querying the symbol index of a freshly spawned server returned an empty result even when the server itself was healthy and the symbol was right there. The representative file is opened before the query, which loads the project.

## [0.15.6] - 2026-07-28

### Fixed

- **The `lsp` extension found no language server in most TypeScript projects.** `tsc` has lived in `node_modules/.bin` for a decade as the compiler, but only TypeScript 7 answers `--lsp`. loop preferred the project's own binary — correct in principle, since a project should get the version it pins — and then launched a TypeScript 5 or 6 with LSP flags it doesn't understand. The handshake failed, the client was dropped, and the whole language went with it: `lsp` reported "no language server available for this file type" and diagnostics silently stopped after every edit. Any project with TypeScript installed locally hit this, which is nearly all of them, and it happened whether loop was started inside the project or above it. A discovered binary is now version-checked before loop speaks LSP to it: a project pinning TypeScript 7 or newer is used as-is, an older one is skipped, and loop falls through to the TypeScript 7 it provisions itself. Only `tsc` declares a minimum today, so no other server pays for the check.

## [0.15.5] - 2026-07-28

### Added

- **The `lsp` extension now answers questions about code, not just complains about it.** It shipped as diagnostics-only with exactly one language server; it now carries an `lsp` tool with nine operations — `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls` — and **37 language servers covering 75 file extensions**. This is the difference between asking "where is this defined" and grepping for a name: the answer comes from the compiler's model of the program, so it skips comments, strings, and unrelated symbols that happen to share a spelling, and `incomingCalls` answers a question grep cannot express at all. Line and character are 1-based, exactly as an editor shows them. The tool is granted to the read-only `plan` agent too, since navigation is the bulk of what planning does and it cannot mutate anything. Enable with `loop enable lsp` or `/extensions`.
- **TypeScript is served by TypeScript 7 itself, with nothing in front of it.** TS7 is a native Go binary that speaks LSP directly (`tsc --lsp --stdio`) and advertises hover, definition, implementation, references, document and workspace symbols, call hierarchy, and diagnostics. loop provisions `typescript@7` on first use and resolves the per-platform native binary inside it, skipping the JS shim — so there is no `typescript-language-server` wrapper and no Node process between loop and the type checker.
- **Servers are found the way a developer would expect.** A project's own `node_modules/.bin` first, then PATH, then — only for servers with a safe install route — automatic provisioning: 10 via npm into `~/.loop/servers/`, plus `gopls` via `go install` (never attempted unless `go` is already on PATH). Everything else resolves from PATH only, deliberately: downloading a compiler's language server behind your back is worse than saying it isn't there. Root detection walks up from the edited file to the nearest project marker, so a monorepo gets one server per package rather than one confused server for the whole tree, and a `deno.json` stands the TypeScript server down instead of double-reporting every diagnostic. A file can be served by several servers at once — a type checker and a linter say different things — and their diagnostics are merged and deduped. Add or override any of it in `~/.loop/servers/servers.json` without waiting for a release.
- **Extensions can now render their own tool calls.** A tool loop doesn't ship had its arguments printed as truncated JSON, which for a five-field call is unreadable. `api.tools.summary(match, fn)` lets the extension that owns a tool own how it reads. The renderer is handed the active **UI mode** and **theme**, so it can match `noir`'s heavier row grammar or `loop`'s flatter one and colour through the real palette instead of hardcoding escape codes. A renderer that throws is ignored rather than taking down the repaint.
- **Extensions can register UI modes and themes.** `api.uiModes.register(mode)` adds a whole chat experience — its own palettes plus declarative style knobs layered over the loop defaults — and `api.uiModes.addThemes(modeId, …)` adds palettes to a mode that already exists. Palettes may be partial: any slot left out inherits from the builtin dark theme, so a mode that restyles six colours doesn't have to restate the other forty-six.

### Fixed

- **Diagnostics reported every file clean against modern language servers.** LSP has two diagnostic mechanisms and servers pick one: the older model pushes `publishDiagnostics` when analysis settles, while the newer one (TypeScript 7 and friends) answers only when asked. loop only listened for pushes, so against a pull-only server it waited out its timeout and concluded there was nothing wrong — the feature looked like it was working and silently never fired. loop now asks when the server advertises that it can answer, and merges the result with anything pushed.
- **A provisioned language server was never upgraded.** The install was skipped whenever the binary already existed, so `~/.loop/servers/<key>/` kept launching whatever was installed the first time — after this release's switch to TypeScript 7, an existing install would have gone on running the old TypeScript 6 server forever. The requested dependencies are now compared against what's installed, and a mismatch reinstalls. Without this, no future server change could ever reach anyone who had used the feature before.
- **An extension-contributed UI mode could not be the one active at startup.** Modes were resolved before extensions loaded, so a mode an extension registered didn't exist yet at the moment the configured mode was chosen, and loop fell back. Extension modes are drained into the registry after load, and the mode and its theme are then re-resolved.

## [0.15.4] - 2026-07-28

### Fixed

- **One slightly-off `edit` silently rewrote the whole file, and the diff hid it.** When an `oldText` didn't match exactly, `edit` fell back to a fuzzy match — and to do it, normalized the _entire file_ and wrote that back as the new content. Every smart quote became an apostrophe, every en- and em-dash became a hyphen, every non-breaking and ideographic space became a plain one, trailing whitespace was stripped from every line, and the whole file was run through Unicode NFKC, which folds half-width kana to full width and rewrites ligatures. A one-line change to a Japanese string table came back with the table rewritten; a one-line change to a Markdown file came back with every two-space hard line break removed. None of it appeared in the tool output, because the diff was computed against the normalized copy too — so the model reported a one-line edit, the user reviewed a one-line edit, and the file on disk had changed everywhere. A fuzzy match is now resolved back to the exact span it covers in the real file through a character-level source map, so only the matched region is ever rewritten and every other byte is left alone. The diff is taken against the file as it actually was, which means it now shows the whole truth.
- **`edit` rejected text that appears exactly once as though it appeared twice.** Uniqueness was counted after fuzzy normalization even when the match itself was exact, so a file holding both `x("don’t")` and `x("don't")` folded them into one string and refused an `oldText` that matched the second one and only the second one: `Found 2 occurrences of the text`. Adding more context could not fix it, because the collision existed only in normalized space — the model was being asked to disambiguate something that was never ambiguous. An exact match is now counted exactly; a fuzzy match, having no exact anchor, is still judged in fuzzy space.
- **`find` cut the first character off every result when searching a path that ends in a separator.** Relativizing a hit assumed the search root needed one more character trimmed for the separator, which is true of `/Users/x` and false of `/`. Searching the filesystem root returned `olumes/…` instead of `Volumes/…` — every path unusable, and wrong in a way that reads as corruption rather than a bug. The prefix is built from the root rather than assumed, which fixes the same latent error on `C:\`.
- **`ls` silently dropped broken symlinks from its listing.** Entries were classified with a `stat` that follows links, and anything that threw — a dangling symlink, an entry the process may not stat — was skipped with `continue`, so the name vanished from the output entirely. To an agent, a name absent from `ls` means the file does not exist, which is the one conclusion the situation does not support. Unstattable entries are listed now, with a broken symlink marked `@`.
- **`grep` with `context` printed the same lines twice and labelled matches as context.** Every match formatted its own window independently, so two matches within `2 × context` lines of each other emitted overlapping runs: the shared lines appeared twice, and a match caught inside its neighbour's window was rendered with the context marker (`file-4-`) in one run and the match marker (`file:4:`) in the next. The model saw the same code twice under two different claims about which lines matched. Overlapping and adjacent windows are merged into one run now, separated by `--` between non-contiguous runs, the way ripgrep prints it.
- **`grep` with `context` invented a blank line at the end of a file.** The same phantom-line bug fixed in `read` in 0.15.3 lived in `grep`'s file reader: splitting on `\n` leaves an empty element after a file's final newline, and context reaching past the last match rendered it as a real, empty line. It also made every file report one line longer than it is.
- **A cancelled turn could still put a request on the wire.** `read` on a URL and `websearch` both subscribed to the abort signal without first checking whether it had already fired. An `AbortSignal` that is already aborted never emits an `abort` event, so a tool call issued after cancellation subscribed to a signal that would never fire again and fetched anyway — measured at a full 200 response returned after the turn was aborted. Both check the signal before subscribing now, the way `bash` already did.
- **`write` reported a file's character count as its byte count.** `content.length` counts UTF-16 code units, so `Successfully wrote 15 bytes` described a file that is 20 bytes on disk. Wrong for any file containing non-ASCII — accented text, CJK, emoji, box drawing — and the tool result is the only size signal the model gets back.
- **A relative path permission rule could be bypassed on Windows.** The cwd-relative form of a path was derived with a hard-coded `/`, so on Windows a `C:\proj` working directory never matched the `C:\proj/` prefix the check looked for, the relative candidate was never generated, and a rule written as `Edit(secrets/**)` failed to match a call made with the absolute path — the precise dodge that code exists to prevent. It uses the platform separator now, and offers the relative form with forward slashes too, since rules are written that way.

### Changed

- **`ls` marks a broken symlink with `@`.** Directories keep their `/`. The alternative to a marker was listing the name bare, which says a dangling link is an ordinary file and moves the confusion one step later, into the `read` that fails on it.

## [0.15.3] - 2026-07-27

### Fixed

- **`read` counted one line too many in every file that ends with a newline, and sent the model back to fetch it.** Splitting on `\n` leaves an empty element after a file's final newline, and that phantom line was counted as real. A 10-line file reported 11 lines; `read` with `limit: 5` said `[6 more lines in file. Use offset=6 to continue.]` when five remained; and a limited read that landed exactly on the last line still printed a continuation hint, which cost a whole tool call to follow and came back empty. Nearly every source file ends with a newline, so this was the ordinary case rather than an edge one, and the wasted read is the kind of thing a model reasons about — an empty result where content was promised reads as a broken file, not a miscount. Totals, remaining-line counts, and `offset=` hints are all computed on real lines now; a full read still renders the file's trailing newline back, so output stays byte-for-byte identical to what is on disk.
- **A file over 2GB could not be read at all, and a merely large one was buffered whole to show ten lines.** The entire file was read into a string before `offset` and `limit` were applied, so a 3GB log threw `Cannot create a string longer than 2147483647 characters` — V8's string cap — no matter how small the requested range, and a 300MB file cost 300MB of memory to return five lines. Files over 8MB are streamed line by line now: that 3GB file reads, and a `read` at offset 1,999,995 of a 200MB log returns in ~226ms holding a few MB. A line too long to display is clipped as it streams rather than assembled first, so a 200MB single-line file — a minified bundle, a one-line JSON dump — reports the line instead of trying to hold it in memory. A streamed read that stops before the end says `[More lines in file. Use offset=N to continue.]` rather than quoting a total it never counted.
- **Binary files were decoded as UTF-8 and printed.** Detection was by extension and covered exactly four image types, so anything else without one of those suffixes — a `.pdf`, a `.so`, a `.heic`, a compiled binary, a `.bmp` — was read as text, putting NUL bytes and replacement characters into the transcript, up to the full 50KB budget of them. `read` now sniffs the first 4KB for a NUL byte, which is the test git uses, and reports `[binary file: 3.1MB at …]` instead.
- **Reading a directory surfaced a raw `EISDIR: illegal operation on a directory, read`.** The readability check passes on a directory and the failure came from the read behind it, as an errno with no advice attached. It now says the path is a directory and points at `ls` and `glob`.
- **A write landing in the middle of a read could be recorded as already seen.** The mtime that read-before-edit compares against was sampled _after_ the content was read, so a file modified in that window was registered at its new mtime while holding the old content, and a later `edit` passed the staleness check against text that was never shown. The mtime is sampled before the read now, which fails toward an extra re-read rather than a silent stale edit.
- **The `sed` command suggested for an over-long line broke on paths with spaces.** It is quoted now.

### Changed

- **Overwriting an existing file with `write` requires having read all of it, not just some of it.** A single `read` with a `limit` — or any read of a file long enough to be truncated — was enough to unlock a full-file overwrite: `read(file, limit: 1)` followed by `write` would replace a 3000-line file whose contents the model had never seen, with nothing to stop it. Reads now record _which lines_ were seen, and `write` over an existing file needs coverage from line 1 to the end. Successive reads add up, so the ordinary way to satisfy it is the one the tool already suggests — follow the `offset=` hints to the end — and a gap left in the middle keeps the overwrite blocked. `edit` is unchanged and still needs only a prior read, since it matches on exact text the model has in hand. The visible effect is that an agent which skimmed a large file and then tried to rewrite it wholesale is now refused and has to either read the rest or make a targeted edit.

## [0.15.2] - 2026-07-27

### Fixed

- **Claude Opus 5 through a gateway failed every turn with an error naming a request loop never sent.** `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"` — except loop was already sending `thinking.type.adaptive`. The rewrite happens in flight: a gateway with its own model table (measured against bifrost) parses the request into its internal form and re-serializes it, and for a model that postdates its table it downgrades adaptive thinking to the retired `enabled` shape, which Anthropic then rejects. The error blames the shape that arrived, so the log points at loop and the fix isn't there. Opus 5 now sends `output_config.effort` with no `thinking` field at all, which is equivalent on that model — thinking is on by default from Opus 5 onward — and is the one form a proxy has nothing to rewrite. `xhigh` on Opus 5 also stopped quietly arriving as `max`.
- **A rejected thinking shape is now corrected from the rejection instead of ending the turn.** No table can describe the failure above, because the fault is in the transport rather than the model — so loop no longer relies only on guessing up front. When an Anthropic-shaped endpoint refuses the thinking parameters, loop reads what it objected to, rewrites the request into the next form (`adaptive` → effort-only → `budget_tokens` → neither, carrying your effort across, translated to a budget where the older form needs one), and re-issues it **once**, transparently — the turn simply runs. The shape that worked is remembered per provider and model in `~/.loop/model-shapes.json`, so every later request starts there and costs one round trip, this session and the next. Only recognized thinking complaints are touched: an auth failure, a rate limit, or a bad `max_tokens` reaches you unchanged, and a correction that doesn't help surfaces the original error rather than its own. This covers the mirror case too — a model or gateway older than the installed build, where the modern shape is the one that gets refused.

### Changed

- **Reasoning is visible again on the models that think the most.** From Opus 4.7 onward Anthropic changed the default for `thinking.display` to `omitted`: the model still thinks, and still bills for it, but the reasoning text comes back empty unless the request asks for a summary. loop never asked, so Opus 4.7, Opus 4.8, and Sonnet 5 streamed a thinking block with nothing in it and the pane sat blank through the pause. loop now sends `display: "summarized"` — visibility only, the thinking and its cost are unchanged — and an endpoint that rejects the field costs you the reasoning text rather than the turn. One model can't be helped: where `thinking` has to be omitted entirely to survive a gateway (Opus 5 above), `display` has nowhere to ride, so it thinks silently until the gateway learns the model.

## [0.15.1] - 2026-07-25

### Fixed

- **`Cmd+V` does not paste an image into the TUI, and 0.15.0 implied it might.** macOS delivers `Cmd+V` to the terminal, not to loop, and the terminal's job for that key is to read the clipboard's _text_ and type it into the program it is running. Raw image data has no text flavour, so there is nothing to type: measured against Ghostty 1.3.1, `Cmd+V` on an image-only clipboard sends **zero bytes** — not the empty bracketed paste 0.15.0 was written to catch, which only some terminals produce. The keystroke never arrives, so nothing inside loop can recover it — 0.15.0's note that `Cmd+V` "attaches too on terminals that report the empty paste" holds only for terminals that send one, which Ghostty does not, and it should not have been read as a working path. `Ctrl+V`, which terminals do forward, is the chord that works, and it is now a _complete_ paste: an image when the clipboard holds one, the clipboard's text when it doesn't, instead of an image-only chord that reported failure on ordinary text and trained you out of the one key that works. And because a paste that silently does nothing teaches you none of this, loop now notices an image sitting on the clipboard and says so — `image in clipboard · Ctrl+V to paste it` on the status line, once per image you copy. The check rides keystrokes that are already being handled, so an idle prompt costs nothing and a session that never copies an image never looks; a copy made in Finder is deliberately ignored, since it carries a file icon alongside the file and the icon is never what you meant to paste.
- **Noir rendered a partial read as though it were the whole file.** A `read` with an offset and a limit came out as a bare `◆ read src/app.ts`, with nothing to say only sixty lines of it had been looked at. The range was being appended by the default tool box rather than by anything the two modes share, and in noir the row is drawn by the mode — so it was simply absent. The row carries it now (`◆ read src/app.ts:120-180`), and the expanded output is numbered down the left with the file's real line numbers, counting from the offset instead of restarting at 1, so a preview can be matched back to the lines it came from. The numbering runs in both UI modes; the `[Showing lines … ]` notice the tool appends stays unnumbered, as does a result that is only a notice.

## [0.15.0] - 2026-07-25

### Added

- **Tab completion for the shell.** `loop completion bash`, `loop completion zsh`, or `loop completion fish` prints a completion script — `loop gate<Tab>` finishes the command, `loop gateways <Tab>` offers `status`, `stop`, and the gateway names, `loop mcp <Tab>` offers its subcommands, and `--cwd <Tab>` completes directories instead of guessing at words. The three scripts are generated from one table of commands, so a new subcommand is described once rather than in three shell dialects that quietly drift apart. Each command runs `loop completion <shell>` and prints where to put the output; zsh's goes on `fpath` rather than being sourced, which is the usual reason a `#compdef` script silently never fires.
- **A manual: `man loop`.** A real roff man page with the commands, options, config file locations, environment variables, and examples, generated from the same command table the completions use so the two can't describe different CLIs. The installer writes it to `~/.local/share/man/man1/`, which is on the default manpath, so `man loop` works after an install with nothing to configure; `loop man` opens it directly, and `loop man --install` rewrites it after an upgrade.

### Fixed

- **The Telegram bot's model picker hid every provider that needs no password.** `/model` listed only providers with stored credentials, which silently excluded all three kinds that have none: a local ollama daemon, bedrock running on ambient AWS credentials, and custom gateways, which are saved somewhere else entirely. There was no error — the models simply weren't there. What counts as a usable provider now has one definition, shared by the terminal, the web UI, and the bot, rather than the correct one living in the TUI and a stricter one behind the API. **The web UI's model picker was quietly missing them too, and is fixed by the same change.**
- **Resuming a session no longer arrives as a dozen notifications.** Replaying a transcript sent one message per turn, so switching sessions buried the chat and lit up the phone once per replayed turn. It is a single message now, split only when it exceeds Telegram's size limit and only ever between turns, never inside one.
- **`/sessions` can reach past the ten most recent.** The list was cut at ten with no way to see the rest; it now pages eight at a time with prev/next that wrap around. The page rides the button rather than being remembered by the bridge, so a menu still works after a restart, two open menus can't fight over one cursor, and a page that no longer exists falls back instead of showing an empty list.
- **`/cost`, `/steak`, and `/context` render straight on a phone.** Cost amounts were padded on the label only, leaving the decimal points ragged down the column. The usage heatmap and the context bar drew themselves with a middle dot and shade blocks borrowed from three different Unicode ranges; Telegram's mobile code font doesn't carry all of them and substitutes per glyph from fallback fonts whose widths don't match, so the grid's columns came out crooked and the bar's drawn width changed with how full it was. Both are plain ASCII now, which has no fallback to go wrong.
- **Pasting an image into the TUI.** `Ctrl+V` attaches an image from the clipboard and `Ctrl+I` opens a file picker — both already worked, but neither was registered, so `/hotkeys` never listed them and there was no way to find out they existed. They are listed and rebindable now, `Ctrl+V` says why nothing happened when the clipboard holds no image instead of appearing broken, and `Cmd+V` attaches too on terminals that report the empty paste it produces (macOS hands `Cmd+V` to the terminal, which pastes the clipboard's text — and raw image data has none).
- **`/new` in Telegram names the model** the new session will run on, instead of leaving you to check afterwards.

## [0.14.1] - 2026-07-25

### Fixed

- **Enabling a gateway in 0.14.0 spawned loop processes without end.** Opening loop with a gateway enabled started a daemon that wasn't a daemon at all: inside a release binary the check for "am I running from source?" read the executable's own virtual entry path, which ends in `.js` and so answered yes for every compiled build. The daemon was launched with that path as its command word, which matches no command, so it fell through to the interactive TUI — and starting a TUI starts the daemons for enabled gateways, which started a TUI, roughly one new process every second and a half until the machine ran out of memory. A real Telegram poller never ran at any point, so the pidfile that exists to prevent a second one was never claimed and never applied. The check now reads the executable, matching how the background-task daemon has always done it, and a process running as a gateway daemon is refused permission to spawn a gateway daemon at all — so even if the invocation were to break again, the chain stops at the first process instead of running away. If 0.14.0 left processes behind, `loop gateways stop` and quitting loop now clear them; a `pkill -f "gateways"` will finish off any strays from the old build.

### Changed

- **Gateways now stop when the loop that started them stops.** A gateway still runs as its own separate process — it can't stall the UI and it isn't tangled up in the TUI's state — but it is no longer independent of it: quitting loop shuts down the gateways that loop started, closing the terminal on a `loop gateways <id>` closes that gateway, and a gateway whose loop is killed outright notices within a few seconds and exits on its own. This reverses 0.14.0, where gateways were deliberately left running after you quit. A bridge that outlives every visible sign of itself is a bridge still accepting shell commands from a chat with nobody watching, and that trade is not worth the convenience of a phone that keeps working after you close the terminal. Daemons started explicitly with a bare `loop gateways`, which exits as soon as it has spawned them, still run until `loop gateways stop` — that command has no session to tie them to.

## [0.14.0] - 2026-07-25

### Added

- **Remote chat gateways, and Telegram as the first one.** `/gateways` sets up chat surfaces that drive loop from your phone (also reachable as the `gateways` row in `/settings`). Every gateway runs as **its own detached daemon process** — never inside the TUI — so the bridge keeps working after you close the terminal, survives a TUI crash, and can never stall the UI's event loop; `loop gateways` spawns the daemons for enabled gateways, `loop gateways status` reports configured/enabled/running with pids, `loop gateways stop [id]` shuts them down, and opening loop brings up any missing daemon while quitting deliberately leaves them running. The framework is generic — a gateway implements one `Gateway` interface (status/enable/disconnect/start) plus a setup screen, and the registry, pidfile daemon lifecycle, `/gateways` manager, settings row, and auto-start pick it up without naming it — so Slack, Discord, or Signal can be added as siblings later. Telegram is the first implementation: paste a BotFather token, tap the printed `t.me` deep link, and the one chat that claims the one-time pairing code owns the bridge (a bare `START` never pairs, and the code is never echoed to an unpaired sender). It talks to the agent over the same JSON-RPC surface `loop serve` uses, so sessions, cost, settings, and extensions are one implementation rather than a parallel one. Long polling means no webhook, no public URL, and no NAT hole — and Telegram's one-poller-per-token rule doubles as a natural lock against two bridges fighting. **Whoever controls the paired chat runs shell commands as you**, which is why pairing is one-shot, single-chat, and set up only from the machine itself.
- **The bot is a full loop client, not a prompt box.** Telegram's native command menu carries `/new`, `/sessions`, `/cancel`, `/queue`, `/model`, `/thinking`, `/settings`, `/cost`, `/context`, `/steak`, `/session`, `/name`, `/compact`, `/export`, `/extensions`, `/cd`, `/status`, `/init`, and `/help` (plus chat aliases like `clear`→`new`, `stop`→`cancel`). Panel commands become inline-keyboard menus you tap — `/settings` toggles in place, `/model` walks provider → model and offers **only providers you're actually logged into**, mirroring loop's own picker rather than listing models that would fail. Turns render as a live multi-message stream: each tool call arrives as its own message (bold verb + argument, subagent calls prefixed) and edits itself in place if the tool fails, while assistant prose streams token-by-token into a message that grows as it types and rolls into a fresh one when it fills — a long answer streams across as many messages as it needs, with nothing truncated. Markdown tables become aligned monospace blocks, since Telegram has no table markup. Switching sessions replays the transcript into the chat, so a resumed conversation has visible context instead of just an id; `/export` ships the full session as a `.jsonl` document. Photos you send are attached as images.
- **Sending a message mid-turn interrupts it.** There is no Esc key on a phone, so the natural way to redirect the agent is to just say the next thing: the running turn is cancelled and yours starts, with the abort reported as an interruption rather than an error. Several messages in a row keep the order you typed them, and only one cancel is sent for the burst. When you'd rather wait your turn, `/queue <message>` (aliases `/enqueue`, `/queued`) runs after the current turn instead of displacing it — bare `/queue` lists what's waiting, `/queue clear` empties it, an interrupt always jumps ahead of anything queued, and `/cancel` drops the queue too so a cancel can't be followed by an ambush turn.

### Changed

- **AI SDK refresh.** `@ai-sdk/amazon-bedrock` 5.0.31, `@ai-sdk/anthropic` 4.0.20, and `@ai-sdk/google` 4.0.24, plus a model-catalog regeneration picking up new upstream models and pricing. Tests, typecheck, and build verified against the new versions.

## [0.13.2] - 2026-07-24

### Added

- **Vercel AI Gateway provider.** `loop login vercel` (or an `AI_GATEWAY_API_KEY` env var) unlocks the gateway's 200+ chat models as `vercel/<creator>/<model>` — one key across Anthropic, OpenAI, Google, xAI, DeepSeek, and the rest, billed through Vercel. Built on the first-party `@ai-sdk/gateway` package, which speaks the AI SDK's native wire protocol rather than an OpenAI-compatible shim, so reasoning effort, provider options, and usage round-trip cleanly. The catalog comes from models.dev overlaid with the gateway's public `/v1/models` for live availability, filtered to chat models only — the gateway marketplace also lists embedding/rerank/image/video/speech models, which have no business in a coding agent's model picker — plus a curated flagship seed (Claude Opus 4.8 / Sonnet 4.6, GPT-5.5, Gemini 3.1 Pro, GLM-5.2, Kimi K3) at live gateway prices. One deliberate omission: the generic `VERCEL_API_KEY` env is _not_ read — that name carries Vercel platform/deploy tokens, which are not gateway keys.

### Changed

- **AI SDK refresh.** `ai` 7.0.37 and provider bumps (@ai-sdk/anthropic 4.0.19, openai 4.0.20, google 4.0.23, amazon-bedrock 5.0.30, gateway 4.0.28), plus a model-catalog regeneration picking up new upstream models and pricing. Tests, typecheck, build, and live streaming verified against the new versions.

## [0.13.1] - 2026-07-23

### Added

- **herdr integration.** Running inside a [herdr](https://herdr.dev) pane, loop now reports its state natively over herdr's socket API: the sidebar shows `loop` with live **working / blocked / idle**, the session id rides along (re-announced across `/new`, `/resume`, and forks), and the pane is released back to herdr's own detection on exit. Blocked means _the agent is waiting on you_ — ask-tool questions and bash/file/plan approval prompts, each labeled ("question: <header>", "bash approval") so herdr can show why — while menus you opened yourself (`/settings`, pickers) deliberately never count, matching how herdr treats Claude's own menus. herdr's completion and needs-attention sounds now fire for loop panes exactly as they do for officially integrated agents. Under the hood this is a generic per-pane agent-status bus fed by the two seams that already see everything (the working indicator and the modal-prompt host), with the herdr reporter as one consumer: hard-gated on the env herdr injects (`HERDR_ENV` + socket + pane id) so it is completely inert outside herdr, fire-and-forget sends with a hard timeout so a dead or restarting herdr server can never slow the TUI, and an ordered send queue with strictly increasing seq. `"herdr": false` in settings (or the `/settings` row) turns it off. Verified end-to-end against a live socket server driving the real TUI.
- **`Notification` hook fires for interactive prompts.** When an agent-driven prompt opens mid-turn (ask tool, approval prompts), the Claude Code–compatible `Notification` hook now fires with `message: "Waiting for input: <label>"` — previously it only fired for PreToolUse denials. Agent-state watchers and custom notification hooks get the same "needs attention" signal Claude Code gives them; user-opened menus don't trigger it.

### Changed

- **AI SDK refresh.** `ai` 7.0.35 and provider bumps (@ai-sdk/openai 4.0.18, google 4.0.22, amazon-bedrock 5.0.28), plus a model-catalog regeneration picking up new upstream models and pricing. Tests, typecheck, build, and live streaming verified against the new versions.

## [0.13.0] - 2026-07-22

### Added

- **Goal mode.** `/goal <objective>` drives the current session autonomously until an adversarial verifier agrees the objective is met. On start, a hidden read-only planner writes a frozen plan (acceptance criteria + a `- [ ]` task checklist) — fail-closed: no usable plan, no goal. After every turn the harness mines the plan's first unchecked checkbox into a continuation nudge and resubmits, at zero extra model cost per round; turn-final hand-off phrases ("stopping here", "let me know if…") get an explicit anti-bail nudge instead. When the checklist runs out, a fresh read-only adversarial verifier (its own context — it never sees the implementer's narration) audits the workspace against the plan: tests must honestly drive the shipped code (hardcoded expectations, mocked-out units, and started-past-the-unit scenarios count as no evidence), fabricated claims and leftover TODO/skipped-test markers refute. Refuted findings feed the next round as a concrete punch list, with an anti-ratchet rule on re-verification (the bar never rises between rounds) so goals converge instead of chasing fresh nitpicks; a clean verdict completes the goal with an OS notification. Esc pauses rather than kills; `/goal pause | resume | status | clear`; guard rails auto-pause instead of burning tokens (40-round cap, 10-verification cap, identical-gaps stall detection, a stuck checklist forces verification). Goal state, the plan, and a scratch dir persist per session under `~/.loop/agent/goal-mode/`, so `/resume` picks a goal back up. Planner/verifier spend is billed to the session under their own ledger sources (`goal-planner`, `goal-verifier`) and reconciles in `loop cost audit`. Verified end-to-end in the real TUI: plan frozen verbatim (including refusing to "correct" a typo'd objective), one implementation turn, verifier passed on the first run.

### Changed

- **`/goal` (background tasks) is now `/background`.** The old `/goal` surface — on-demand detached runs and once/cron-scheduled tasks — moves to `/background` (alias `/bg`): bare opens the same manager, `/background <text>` is the same AI quick-add, `/daemon` is unchanged. The `/goals` alias is gone; the `goal` name now belongs to goal mode above. Headless runs are named `background: <text>`, and `loop background` works alongside the unchanged `loop goals` CLI subcommand (kept verbatim so already-installed daemons keep firing).
- **AI SDK refresh.** `ai` 7.0.34 and the `@ai-sdk/*` provider line (anthropic 4.0.18, openai 4.0.17, google 4.0.21, xai 4.0.18, amazon-bedrock 5.0.27, cerebras 3.0.14, deepseek 3.0.13, groq 4.0.13, mistral 4.0.14, mcp 2.0.16). Tests, typecheck, build, and live streaming verified against the new versions.

## [0.12.15] - 2026-07-19

### Added

- **Workspace context files are protected from the agent.** The bash tool now refuses to delete or move `AGENTS.md` / `CLAUDE.md` (`rm`, `unlink`, `shred`, `trash`, `mv`, `git rm`, `git mv` — per segment, so chained, wrapped, and absolute-path forms are caught) on the model's own initiative. These files feed the system prompt every turn; losing one silently changes how the agent behaves in the repo. Interactively the attempt shows the normal approval prompt; in print mode / RPC it fails closed with an instructive refusal. An explicit whole-command `allow` permission rule still approves it — a deliberate written decision, same as the other dangerous commands — but remembered "always allow" grants never do. Verified live: the agent's `rm <abs-path>/CLAUDE.md` is refused and the file survives.

## [0.12.14] - 2026-07-18

### Fixed

- **`loop run --session <id>` actually resumes.** The flag — long advertised in `--help` — was silently ignored: every run created a fresh session, forking your history without a word. It now loads the session (full prior context carries into the turn, verified end-to-end), defaults the model and working directory to the session's own, and an unknown id fails loudly with exit 1 instead of quietly starting over. `--model` and `--cwd` still override per-run.
- **`loop run - < file` works.** Reading the prompt from a shell redirect printed the Usage error even though a pipe (`cat file | loop run -`) worked: in the bundled build, the stdin stream saw EOF without ever delivering a regular file's bytes — pipes only survived by arrival timing. Non-tty stdin is now read directly from the file descriptor, so redirects, pipes, and heredocs all behave the same; a tty keeps the old streaming path for interactive Ctrl+D input.

## [0.12.13] - 2026-07-18

### Fixed

- **Terminal tab progress indicator actually works now.** The OSC 9;4 "working" indicator added for Ghostty/WezTerm/iTerm2 tabs sent state `1` (set percentage) with an invalid `-1`, which terminals drop or render as 0% — it now sends state `3` (indeterminate), so the tab shows a busy indicator for the whole turn. The working indicator also routes through the TUI terminal's single `setProgress` implementation instead of a second private copy of the escape-writing machinery.
- **No more stuck tab progress after a crash or signal.** The indicator is now cleared on every exit path: the TUI's exit safety net (SIGINT/SIGTERM/SIGHUP and `process exit`) and `terminal.stop()` both emit the OSC 9;4 clear when the bar was shown. The clear is deliberately skipped when the bar never appeared, so old iTerm2 — which renders unknown OSC 9 as a notification popup — sees nothing.

## [0.12.12] - 2026-07-18

### Changed

- **OpenRouter provider off the alpha.** `@openrouter/ai-sdk-provider` moves from the pinned `6.0.0-alpha.1` pre-release to the current stable `^3.0.0` release line (upstream's versioning jumped 3.0.0 → 6.0.0-alpha, so the lower number is the newer build). The stable line ships against the `@ai-sdk/provider@4` spec — the alpha was v3-spec — and is the release line upstream supports for `ai@^7`: no more "backward-compat keeps it working", this is the intended pairing.
- **Dependency sweep.** `@aws-sdk/credential-providers` 3.1090.0, `shell-quote` 1.10.0, `marked` 18.0.6, plus dev bumps (`@types/node` 26.1.1, prettier 3.9.5). The monorepo root also dropped its duplicate `@ai-sdk/*` entries — they only ever belonged to `@notshekhar/loop-core`, which already pinned the same versions. Build, typecheck, and the full test suite verified.

## [0.12.11] - 2026-07-17

### Fixed

- **Kimi cache hits now show up.** Kimi reports prompt-cache hits as OpenAI-style `usage.cached_tokens`, but the DeepSeek SDK the provider rides only understands DeepSeek's `prompt_cache_hit_tokens` — so the cost ticker and `/context` always showed `cache:0` even though Moonshot's automatic prefix caching was hitting (and billing you the cheap tier) the whole time. A fetch-layer rewrite now maps the field for both JSON and streaming responses; live-verified on a Kimi Code subscription (2560 of 2622 prompt tokens read from cache on the second call).

### Changed

- **AI SDK refresh, for real this time.** The v0.12.10 notes claimed the `@ai-sdk/*` minor updates but the dependency bumps never made it into that commit — this release actually pins them (anthropic/openai/xai 4.0.16, google 4.0.18, deepseek/cerebras 3.0.12, groq 4.0.12, mistral 4.0.13, amazon-bedrock 5.0.24, mcp 2.0.15, ai 7.0.31), plus the build-time models.dev price refresh. Tests, typecheck, and live streaming verified against the new versions.

## [0.12.10] - 2026-07-17

### Added

- **Kimi (Moonshot AI) as a built-in provider.** `loop login kimi` (or set `KIMI_API_KEY`), then pick a model with `/model`. Both key kinds work and route automatically by prefix: pay-per-token platform keys (`sk-…`) hit `api.moonshot.ai` with the Kimi K3 / K2.7 Code / K2.6 catalog at real prices, while Kimi Code subscription keys (`sk-kimi-…`) hit `api.kimi.com/coding` and swap the catalog for the plan's models (`k3`, `kimi-for-coding`, `kimi-for-coding-highspeed`) at $0 — re-pasting the other kind via `/login` re-routes everything. Rides the DeepSeek SDK, so `reasoning_content` thinking streams live and round-trips across turns; the thinking level toggles Moonshot's `thinking` switch. `LOOP_KIMI_BASE_URL` overrides the endpoint (e.g. `api.moonshot.cn` for China).

### Changed

- **AI SDK refresh.** Minor updates across `@ai-sdk/*` (anthropic/openai/xai 4.0.16, google 4.0.18, deepseek/cerebras 3.0.12, groq 4.0.12, mistral 4.0.13, amazon-bedrock 5.0.24, mcp 2.0.15); tests, typecheck, and a live streaming call verified against the new versions.

## [0.12.9] - 2026-07-16

### Changed

- **Installer download progress bar.** `install.sh` and `install.ps1` (and therefore `loop update` / `/update`, which re-run them) now draw a live `■■■････ 42%` bar while the release tarball downloads. The bash installer parses a `curl --trace-ascii` stream through a FIFO (TTY only, falling back to `curl --progress-bar`; unlike the technique's origin, an HTTP error fails the download instead of saving the error page). The PowerShell installer streams via HttpClient with the same bar, degrades to `Invoke-WebRequest` on any failure, uses `·` so legacy conhost codepages render cleanly, and opts Windows PowerShell 5.1 into TLS 1.2.

## [0.12.8] - 2026-07-16

### Added

- **Permission rules: allow / ask / deny over the tools.** A new `permissions` key in settings.json (managed via `/permissions` or the `/settings` row) takes rule strings like `Bash(git *)`, `Read(secrets/**)`, `Edit(**/*.pem)` — deny always wins, ask forces an approval prompt even with bash approval off (failing closed in print mode/RPC), allow skips the prompt. Bash deny/ask rules match every executed segment (chains, `sh -c`, command substitution, env/wrapper prefixes) while allow matches the whole command only, so an allowed prefix can't smuggle a blocked segment. `Read` rules also govern `grep`/`find`, and trusted projects can add rules from `<project>/.loop/settings.json`. Full syntax and evaluation order: `loop://docs/permissions.md`.
- **Per-project "always allow" + dangerous-command re-prompts.** Approval-prompt grants now persist per project instead of globally (the legacy global `bashAllow` list still matches), the prompt gained a "never allow" row that feeds `bashDeny`, and dangerous commands (`rm`, `chmod`, `kill`, `git push`, …) always re-prompt instead of riding a remembered grant — only an explicit written allow rule approves them silently.
- **Enforced plan mode.** `/plan` (or `/plan <task>`, or Shift+Tab onto the plan agent) locks the session read-only at the tool layer in every permission mode: edit/write are rejected and bash runs in the fail-closed kernel read-only sandbox — subagents inherit the lock. The agent can request it mid-task via the new approval-gated `enter_plan_mode` tool when the approach is genuinely ambiguous. Accepting a delivered plan ("implement it") lifts the lock; the status line shows `plan mode (read-only)` while it's on.

## [0.12.7] - 2026-07-16

### Fixed

- **Release CI: fix the flaky multi-client RPC serve test for real.** v0.12.6 mocked the whole agent module, but Bun shares mocks across files so rpc/abort/reopen tests broke with `Unknown provider: nope`; that mock is gone. v0.12.6/v0.12.7 also reordered `getModel` in production `turn.ts` purely to speed the test up — that has been reverted (no production change for a test). The test just does real work (spin a session, fail on a bogus provider) that a loaded CI runner can't finish inside Bun's 5s default, so it now gets a 30s timeout budget.

## [0.12.6] - 2026-07-16

### Fixed

- **Release CI flake in the multi-client RPC serve test.** Waiting for a real `runTurn` with an unknown provider still loads catalog/skills/tools before failing, which exceeded the wait under CI load. The test now mocks `runTurn` to fail instantly so broadcast/attach/detach stay deterministic.

## [0.12.5] - 2026-07-16

### Fixed

- **Stop during a web UI turn actually ends the turn.** Abort used to skip the stream `finish` event, so the composer stayed locked and tokens kept looking live after you hit stop. Aborted turns now emit `finish`, and the client clears running state as soon as you click stop.
- **Flaky multi-client RPC serve test.** It waited a fixed settle window and asserted the last event was `error`, which raced under CI load; it now waits for the error itself and uses a real temp cwd.

## [0.12.4] - 2026-07-16

### Fixed

- **`loop serve` no longer sticks on "connecting…".** Inlining the minified web bundle used a string-form `String.replace`, which treats `$&` in the JS as "insert the match" — so a minified `$&&` became an HTML comment mid-script and the browser never ran the client. Replacements now use a function so `$` in the bundle stays literal.

## [0.12.3] - 2026-07-16

### Fixed

- **`loop serve` in the compiled binary no longer 500s on every page load.** The standalone binary never baked the web UI into `__WEB_UI_HTML__`, so it tried to resolve `@notshekhar/loop-web/app` from inside the binary filesystem and failed. Release builds now embed the page the same way core's npm dist already did.

## [0.12.2] - 2026-07-16

### Changed

- **Mobile home uses an OpenCode-style project dialog.** The cramped horizontal project chips and Esc-only open-path popup are gone: one Projects button opens a closable dialog (backdrop tap + close) with a filterable project list and an Open path field. Desktop keeps the side rail.
- **Composer send stays right-aligned on desktop.** Hiding an empty status line no longer drops the flex spacer that pinned send to the trailing edge.

## [0.12.1] - 2026-07-16

### Added

- **Streak stats under the usage heatmap.** `/steak` and `/cost` now show your current streak, longest streak, active days, and busiest day beneath the graph — the same numbers as the web UI's usage dialog, computed once in core so every client agrees. A quiet "today" doesn't break the streak until the day is over.

### Changed

- **`loop serve` binds `0.0.0.0` by default and prints the network URL with its token.** Reaching the UI from another device is the point of serve, and the token is the lock either way — so the LAN URL is now copy-pasteable as printed. `--host 127.0.0.1` restores a loopback-only bind (which still previews the LAN URL it would serve).
- **The browser client is its own workspace package.** `packages/web` owns the serve UI as small focused modules (state, RPC client, transcript renderer, per-feature files) instead of one 3,600-line embedded HTML file. Builds bake the compiled single-file page into core — release binaries stay self-contained — while source runs bundle it on the fly, so web edits show up on reload.

### Fixed

- **The web UI behaves on phones.** Streaming no longer janks the page (deltas paint at most once per frame, so typing stays smooth while the agent responds); the composer keeps send on one row, autosizes in CSS, and stays clear of the on-screen keyboard and the iPhone home bar; the header wraps to two rows so the actions never squeeze out the session title (and the cost readout is back on mobile).

## [0.12.0] - 2026-07-15

### Added

- **`loop serve` — a token-protected web UI for remote use.** Enable `serve` in `/settings`, then run `loop serve` to open Loop's sessions in a browser. It is loopback-only by default, supports a chosen host/port, and prints a bearer-token URL; use Tailscale, SSH, or Cloudflare Tunnel for remote TLS access. Open web clients see a session's transcript and, for turns started in the web UI, live text, reasoning, tool, and subagent events; reconnects replay missed events. Treat the URL as full control of the machine.
- **Image and PDF attachments accept more real-world drops.** Finder-style paths with spaces, shell-escaped paths, and `file://` URLs are recognized. PDFs now attach for providers that support inline PDF data; unsupported attachments remain visible as ordinary path text instead of disappearing.

### Changed

- **Prompt editing follows macOS conventions more closely.** Cmd+Left/Right move to a line boundary, Cmd+Up/Down move to the start/end of the input, Cmd+Backspace deletes to the line start, Cmd+Z undoes, and Up on the first visual line enters prompt history.

## [0.11.5] - 2026-07-13

### Changed

- **Ctrl+E is the only way into transcript navigation.** Esc on an idle empty prompt and ctrl/alt+arrows no longer drop you into nav mode — a stray Esc or a macOS cmd+arrow gesture kept flinging people into the transcript. Inside nav nothing changed: arrows still walk entries, alt+arrows still jump turns, and Esc still exits. The welcome banner now mentions the shortcut (`Ctrl+E navigates transcript`).

## [0.11.4] - 2026-07-13

### Fixed

- **Noir's day theme no longer shows invisible text in dark terminals.** The canvas wash set only the terminal's default background (OSC 11), so anything drawn at the terminal's default foreground — white, in a dark terminal — disappeared against the day theme's light canvas. The wash now sets the default foreground to the theme's text color too (OSC 10), restores both on exit (OSC 111/110), and the crash-safe startup cleanse clears a killed session's leftover foreground as well.

## [0.11.3] - 2026-07-12

### Changed

- **The internal docs caught up with the last five releases.** `loop://docs/config.md` — what the agent reads when you ask it to configure loop — now covers the `todos` checklist setting, the `skills` toggle (and where skill folders live), UI modes (`uiMode`, `/ui`, per-mode themes), the full set of custom-provider auth kinds (`apikey`, `bearer`, `env`, key `helper` with JSON stdout + expiry, `oauth` with discovery escape hatches), and the `todo`/`skill` entries in a custom agent's `tools:` list.

## [0.11.2] - 2026-07-12

### Changed

- **Noir is the default UI mode.** A fresh install — or any setup that never picked a mode — now opens in noir: dark washed canvas, diamond tool rows, collapsing thought blocks. An explicit `uiMode: "loop"` in settings keeps the classic look, and `/ui loop` switches back at any time.

## [0.11.1] - 2026-07-12

### Fixed

- **The todo panel clips by display width.** Overlong rows truncate by terminal cells instead of string length, so wide characters (CJK, emoji, Devanagari) never split at the clip point and a clipped row keeps its styling — an overlong in-progress row used to lose its cyan.
- **Resumed sessions keep todo state in sync.** Replaying a branch (resume, fork, tree navigation, `--session`) now seeds the agent's canonical todo map alongside the pinned panel, so staleness nudges and RPC readers agree with what's on screen after a process restart; switching to a branch without a checklist clears the stale one.
- **Aborted turns always emit `finish`.** One early-return path skipped the event, leaving finish-keyed consumers (an RPC client) waiting forever.
- **Memory-index truncation cuts on a line boundary.** The size cap counted bytes but sliced UTF-16 units, so it could split a multibyte character — and always split an index line mid-sentence.

## [0.11.0] - 2026-07-11

### Added

- **The model can invoke skills directly.** A new `skill` tool lets the agent call a skill by name and get its instructions in one step, instead of only being pointed at a SKILL.md path to read. It rides the existing `skills` setting and project-trust gate — nothing new to enable — and an unknown name returns the real list of available skills. Skills with `disable-model-invocation` stay hidden from it, subagents keep the read-based flow, and reading the file directly still works everywhere. The tool shows up in `/context` accounting, and restricted agents opt in by naming `skill` in their tool list.

### Changed

- **The todo panel no longer outlives the turn.** When a turn ends — finished, interrupted, or failed — the pinned checklist retires into the scrollback as a one-line summary (`todos: all 5 done`, `todos: 3 of 7 open`) instead of sitting under the prompt forever. The list itself is kept, so staleness nudges and resumed sessions still know where you left off.

## [0.10.11] - 2026-07-10

### Added

- **The ask tool got a review step and question navigation.** Answers are no longer sent as you pick them: after the last question a review screen lists every answer (with `(skipped)` rows for unanswered ones) and nothing reaches the model until you hit **Submit** — Enter on a row (or its digit) reopens that question to change the answer. While answering, `←/→` move between questions with all state kept: the cursor row on a single-select, the ticked boxes on a multi-select (ticks count as the answer even without `done`). `Esc` now means _dismiss_: with nothing answered the whole prompt resolves immediately as declined so the agent proceeds on its own judgment; with answers already given it jumps to the review so nothing is sent unseen.
- **Clipboard writes work beyond macOS.** `/copy`, `y` in transcript navigation, and the `/share` URL copy now go through the platform's own tool — `pbcopy` (macOS), `clip` (Windows), `wl-copy`/`xclip`/`xsel` tried in order (Linux) — and report honestly when no tool is available instead of claiming success.

### Fixed

- **One arrow press no longer acts twice in the ask flow.** Under the Kitty keyboard protocol a physical key press also emits a release event; the ask menus acted on both, so a single `←/→` jumped two questions.
- **Switching UI modes rebuilds the transcript.** `/ui <mode>` used to repaint the old component tree, leaving a hybrid of both modes on screen (mode decisions are baked in when components are constructed); the transcript now re-renders under the new mode, `/reload` does the same when the mode changed on disk, and a mid-turn switch is rejected instead of orphaning the live streaming components.
- **Noir polish.** Failed tool rows fold like everything else (the red diamond carries the signal; expand to read the error); durations no longer print `60s` or `1m00s` at the minute boundary; and mode themes or older custom theme files with missing slots fall back to the builtin dark theme's vars instead of throwing at render time.
- **Navigation-mode input hardening.** Emoji/IME input exits nav mode back to the prompt like a plain letter; horizontal trackpad tilt no longer scrolls the window; `/hotkeys` reflects the current Tab/Shift+Tab and Ctrl+E bindings.

## [0.10.10] - 2026-07-10

### Added

- **UI modes.** The chat is now a pluggable experience: `/ui <mode>` (or the `uiMode` row in `/settings`) switches between the builtin `loop` look — unchanged, still the default — and the new **`noir`** mode: the terminal background washes to a deep dark canvas (OSC 11, restored on exit), tool calls render as flat `◆ name` rows whose diamond carries the state (yellow running, green done, red failed), reasoning collapses to a `◆ Thought for Xs` row when the turn moves on, user prompts get a `❯` prefix with right-aligned timestamps, and each turn ends with a "Turn completed in Xs." line. Each mode owns its themes: loop keeps `dark`/`light`, noir ships `night` and `day`. Subagents render as the same rows with live status and run stats; the plan tool keeps its full box (it's an approval surface). Under the hood every mode is a style spec + block renderers over one registry, so future modes (and eventually extensions) plug into the same seam.
- **Transcript navigation.** `ctrl+e` toggles a navigation mode (also: `Esc` on an idle empty prompt, or `alt+↑` to jump straight to the last user turn): `↑/↓` walk every entry — user prompts, responses, thinking, tool calls — with a selection bar, `→/←` expand or fold the selected entry individually, `Enter` toggles it, `shift+←/→` jump between user turns, `e` expands everything, `y` copies the selected entry, and a click selects the entry under the pointer. The transcript renders in a window that follows the selection, scrollable with the mouse wheel, `PgUp/PgDn`, `ctrl+u/d`, and `Home/End` — expanding a huge tool output no longer flings the view, and a streaming turn no longer drags the window to the bottom while you read.
- **Thinking time survives resume.** Each reasoning block's wall-clock duration persists with the turn (`reasoningMs` on the message entry), so a reopened session shows the real "Thought for 3.2s" instead of forgetting.
- **`loop --session <id>` replays the transcript.** Opening a session by id used to restore only cost and context — now the conversation renders, like `/resume`.

### Fixed

- **An over-wide line no longer kills the TUI.** The renderer's width-overflow guard used to stop the UI and throw — the infamous dead screen where keystrokes echo below the input box. It now clamps the line, logs the evidence once to `loop-crash.log`, and keeps running. The welcome banner also truncates deep working-directory paths, and noir's one-line rows truncate long commands, closing the whole bug class.
- **Startup cleanses stale terminal modes.** A previous loop killed with SIGKILL never restored the terminal (kitty keyboard protocol, mouse reporting, background color) — the shell then echoed raw key reports like `[9;5u`. Launching loop now resets those modes first, and the crash safety net resets mouse reporting and the background wash too.
- **Aborted turns freeze their pending tools.** Interrupting a turn used to leave still-running tool boxes spinning forever; they now render as `· interrupted`, and resume shows whatever actually completed.
- **Resume matches the live view.** Subagent boxes replayed in finish order instead of stream order and with different spacing; a resumed transcript is now line-for-line identical to what streamed live.
- **Smooth wheel scrolling in navigation mode.** Trackpad micro-events that alternate direction on slow scrolls are coalesced into one net movement, so the window no longer flickers between the same lines; fast flicks are capped at a page.

## [0.10.9] - 2026-07-08

### Added

- **Todo items can be cancelled.** A step that turned out unnecessary gets `status: "cancelled"` instead of being deleted or fake-completed — the panel renders it as a struck-through `[-]` row, and a list whose items are all completed or cancelled retires into the scrollback as before.

### Changed

- **The agent no longer loses track of its own checklist.** Three fixes borrowed from the best of opencode, gemini-cli, and Claude Code: every todo write now echoes the full numbered list back as the tool result, so the current state lives where the model actually re-reads it; when auto-compaction summarizes away the last todo write, the active list is re-injected right after the summary instead of silently orphaning the pinned panel; and a gentle, never-persisted reminder nudges the agent when an active list has gone ten tool calls without an update — or, once per turn, when a long multi-step job never made one. The `todos` setting is still opt-in (default off).
- The todo tool's guidance grew the rules that make checklists trustworthy: completions are marked only after the work is verified, blocked steps stay in progress with a follow-up todo naming the blocker, and follow-ups discovered mid-job get captured instead of dropped.

## [0.10.8] - 2026-07-08

### Added

- **Todo checklists.** A new `todo` tool lets the agent keep a visible checklist during multi-step work, rendered as a pinned panel between the loader and the editor — `[>]` marks the step in progress, and a fully-completed list retires into the scrollback as one line. Lists persist with the session, so `/resume`, `/fork`, and `/tree` restore the branch's latest checklist. Opt-in: toggle `todos` in `/settings` (default off).
- **loop as a GitHub Action.** `uses: notshekhar/loop@v0` installs the released binary and runs a prompt headlessly in CI — the response lands in a step output, the job summary, and (with `post-comment: "true"`) a PR comment that updates in place on later pushes. Auth rides the caller's env (`ANTHROPIC_API_KEY` etc.), no config files. This repo now dogfoods it: loop reviews its own pull requests.
- **`loop run` grew CI manners.** `loop run -` (or piping with no prompt argument) reads the prompt from stdin — no shell-quoting a PR diff — and `--max-steps <n>` caps the turn.

### Fixed

- **Headless runs no longer exit 0 after a failed turn.** A turn-level stream error in `loop run` (bad key, dead endpoint) now sets exit code 1 instead of burying an `[error]` line in stderr — tool-level errors the agent recovers from still exit clean.
- **/context stopped ignoring extension prompt injections.** System prompt text added by extension `onSystemPrompt` middleware (the caveman/ponytail builtins, or any extension persona) now shows up as its own "Extension prompt" bucket instead of silently missing from the breakdown. The report also counts the conditional websearch/ask/todo tools when their settings enable them.

## [0.10.7] - 2026-07-08

### Added

- **Custom-provider OAuth setup no longer dead-ends.** The `/login custom` OAuth wizard now checks for `.well-known` metadata up front — when the server exposes none it asks for the authorization/token endpoint URLs, and when dynamic client registration is missing it asks for your client id, instead of failing mid-login with an error about config fields the wizard never offered.
- **Key-helper credentials survive restarts and can carry a real expiry.** The custom-provider "Command (key helper)" auth method now persists minted keys in `~/.loop/auth.json` until they expire, so interactive helpers (a vendor login that opens a browser) stop re-prompting on every launch. Helper stdout may also be JSON — `{"key": "…", "expiresAt": <epoch-ms or ISO>}` (`apiKey`/`token` and `expiresInMs` accepted too) — so the key's actual lifetime drives re-runs instead of the blind 5-minute TTL. A 401 still forces a fresh mint.

### Fixed

- **Hooks can read the transcript again.** Since sessions moved to SQLite, the `transcript_path` in hook payloads pointed at a JSONL file that was never written. The transcript is now materialized on demand right before a matching hook runs — hooks that read it (a common Claude Code pattern) see the real, current conversation, and configurations with no hooks write nothing.
- **/cd (and /cwd) now finds the target directory's sessions.** Session storage keys on the canonical path, but /cd stored the path as you typed it — so `/cd /tmp/x` (really `/private/tmp/x` on macOS) or a differently-cased path left `/resume` claiming the directory had no sessions.

### Changed

- The `/da` shortcut is gone; use `/data` for the data-analyst agent.
- Internal: the machinery the main turn loop and subagent runs share (request shaping, per-step billing, stream yielding) is now one module used by both, so fixes land in both loops by construction.

## [0.10.6] - 2026-07-08

### Added

- **loop now remembers.** The agent saves durable per-project facts — your preferences, project decisions, hard-won gotchas — as plain markdown files under `~/.loop/agent/memory/`, and recalls them in every later session through a small always-loaded index (full memories are read only when relevant, so your context stays lean). No hidden machinery: saves happen with the normal write tool, visible in the transcript like any file change, and the files are yours to edit or delete — `/memory` → "Agent memory (auto)" opens the index, `/context` shows what memory costs you. Toggle with `memory` in `/settings` (default on).
- **Parallel subagents.** When the model fans out several task calls in one step they now stream concurrently instead of one after another. `subagentMaxParallel` in `/settings` caps the concurrent provider streams (default 4, 0 = unlimited); excess tasks queue visibly and start as slots free up.

### Removed

- **Legacy one-time migrations retired.** The `~/.pi` → `~/.loop` config-dir move and the pre-v0.9 JSONL-session / cost.json / trust.json migrations are gone — every install has long since moved. If you're somehow upgrading from a pre-0.9 version, go through 0.10.5 first; database corruption recovery itself stays.

## [0.10.5] - 2026-07-07

### Fixed

- **Tool-box background colors now reach the right edge on Hindi and other Indic text.** Terminals like Ghostty attach a whole grapheme cluster to one cell pair (capped at 2 cells), so clusters like र्मा render narrower there than the per-codepoint sum loop used — the padding came up short and the colored fill stopped before the box edge. The startup width probe gained a third canary that detects this layout and calibrates cluster widths to match, verified cell-exact against Ghostty across Devanagari, Bengali, Malayalam, Tamil, and CJK.

## [0.10.4] - 2026-07-07

### Fixed

- **Hindi and other complex-script output no longer smears the screen while streaming.** The TUI measured every Devanagari-style grapheme cluster as one column, but terminals lay out conjunct consonants and spacing matras in their own cells — so long Indic lines overflowed the terminal width, auto-wrapped, and each repaint drifted, leaving a staircase of stale text. Cluster widths are now summed per codepoint the way terminals do it (covering Devanagari, Bengali, Tamil, Myanmar, Khmer, decomposed Korean, and friends), and on startup loop probes the terminal with two invisible canary clusters to calibrate against how it actually renders them.

## [0.10.3] - 2026-07-07

### Added

- **/daemon** — toggle the goals background scheduler from inside the TUI. Bare `/daemon` opens a panel showing whether it's on and offers the flip (install/uninstall the launchd agent / systemd user timer / Task Scheduler job); `/daemon on|off|status` skips the panel. `loop goals daemon install|uninstall|status` still works on the CLI. In-session daemon hints now point at `/daemon` instead of the CLI command.

## [0.10.2] - 2026-07-07

### Changed

- **Goal notifications and summaries show only the final response.** A goal run's summary — the desktop notification body, `loop goals run` output, and the stored last-run summary — is now the model's closing response after its last tool call (like a subagent's report), instead of the tail of everything it streamed along the way. Failed runs summarize the error instead.

## [0.10.1] - 2026-07-07

### Changed

- **Unscheduled goals now run immediately in the background.** `/goal convert utils.js to ts` (no time mentioned) fires a detached headless run right away — matching how background tasks work in other coding agents — instead of becoming a "standing objective". System-prompt injection of goals is removed entirely (use AGENTS.md for persistent instructions); the `goals` setting is gone with it. On-demand goals stay in the `/goal` panel for re-running.
- `loop sessions` shows the session name (e.g. `goal: …`) instead of the first prompt line when one is set, so goal runs are recognizable at a glance.

## [0.10.0] - 2026-07-07

### Added

- **Goals** — a goal is a stored objective tied to a directory. `/goal <text>` parses natural language with your current model (schedule words and agent mentions included: "check the deps every day at 9am with the plan agent") and confirms before saving; any parse failure just saves a standing goal. Standing goals are surfaced to the agent in the system prompt of every session in that directory (mute with the `goals` setting). Scheduled goals (once/cron) run **headless even when loop is closed** via `loop goals daemon install` — a launchd agent (macOS), systemd user timer (Linux), or Task Scheduler job (Windows, with desktop toasts) that ticks every minute. Each run is a normal, resumable session named `goal: …`, records status + summary on the goal, and fires a desktop notification. Every goal can pin its own model and agent (unset = your defaults at run time). Manage in the `/goal` panel (add, edit text/schedule/model/agent, run now, open last run, delete) or via `loop goals list|add|rm|run|tick|daemon`.
- **Plan delivery** — the plan agent now ends its turn by calling a `plan` tool with the finished plan instead of trailing off in prose. The plan streams live and renders as full markdown (it's the deliverable — never collapsed), then you choose **implement it** (pick an agent; the plan is handed over as a one-shot) or **talk about it** (keep refining with the plan agent). Custom planner agents opt in by naming `plan` in their tools list.

### Changed

- Session database schema is now v5 (goals table). Older loop builds refuse a v5 database — upgrade all machines sharing a config dir.

### Added

- **websearch tool** — web search via DuckDuckGo, no API key needed. Opt-in: flip `websearch` on in `/settings` (or `"webSearch": true` in settings.json). Returns the top results as title/URL/snippet — pass a result URL to the read tool to fetch the full page. Sponsored results are filtered out. Subagents inherit it, print mode gets it too, and custom agents can opt in by naming `websearch` in their tools list. Heads-up: it scrapes DuckDuckGo's HTML endpoint, which is unofficial and may rate-limit.

### Fixed

- **Streaming edit/write preview reads top-down.** While a file is being written, the content now streams above and the `… +N earlier lines (ctrl+e to expand)` hint sits below it — matching how the finished diff collapses.

## [0.9.9] - 2026-07-06

### Added

- **/context** — context-window usage breakdown: a colored 10×20 cell grid (each cell = 0.5% of the window) with per-category estimates (system prompt, system tools, MCP tools, workspace context, skills, messages, compact summary), free space with the auto-compact threshold, and a per-skill token list. The headline count prefers the provider-reported context size; categories are chars/4 estimates.
- **/cd** — move this session to a new working directory (with `~` expansion, relative resolution, and existence checks). The session is truly re-homed: `/resume` finds it under the new directory. `/cwd` is now an alias.
- **/memory** — pick a context-file location (global `~/.loop/AGENTS.md`, project `AGENTS.md`, `.loop/AGENTS.md`, directory-level; legacy CLAUDE.md honored) and open it in `$VISUAL`/`$EDITOR`, creating it if missing.
- **/doctor** — read-only diagnostics: version vs latest release, runtime, config dir, settings, session-DB integrity check, provider auth, model catalog, MCP server statuses, extensions, project trust, and optional binaries — each as a pass/warn/fail line.
- **/share** — upload the session as a **secret** GitHub gist via the `gh` CLI: a readable `transcript.md` (tool calls collapsed, raw tool outputs excluded) plus the raw `.jsonl` for `/import`. Confirms before uploading; URL is printed and copied to the clipboard.
- **/scoped-models + Ctrl+P** — pick a set of models in a searchable toggle panel (or `add <id>` / `rm <id>`), then cycle through them with Ctrl+P. Unavailable models are skipped automatically.
- **/recap** — generate the post-turn recap on demand for the last turn, regardless of the `recap` setting.
- **/init** — analyze the codebase and write (or improve in place) an `AGENTS.md`, run as a normal agent turn.
- **/release-notes** — alias for `/changelog`.
- **Type-to-filter in all toggle panels** — multi-select lists (scoped models, agent tool pickers, …) now have the same live search box as the single-select pickers. Space still toggles; printable keys filter.

### Fixed

- **Returning from an external editor no longer leaves the keyboard dead.** Terminal handoff (used by `/memory`) now blocks the event loop while the editor runs — the async version let renders fight the editor's screen and broke stdin on return.

## [0.9.8] - 2026-07-05

### Fixed

- **TUI re-synced with upstream pi-mono** (our editor/terminal layer is a light fork; this pulls everything fixed upstream since we vendored it, on top of our local changes):
    - Up arrow on the first line no longer hijacks you into prompt history while typing — it jumps to the start of the line; history opens only when the editor is empty, you're already browsing it, or the cursor is at column 0.
    - Streaming code fences render stably while output is arriving.
    - Markdown lists keep their original unordered markers, and loose lists get blank lines between items.
    - Overlays align correctly over CJK wide cells.
    - Autocomplete fuzzy filter understands slash-separated tokens (matching `foo/bar` paths piecewise).
    - Kitty image protocol is enabled under the Warp terminal.

### Added

- **Terminal color-scheme detection (groundwork)** — the TUI can now query the terminal background via OSC-11 and report light/dark, per upstream. Not wired to anything user-facing yet.

## [0.9.7] - 2026-07-05

### Changed

- **AI SDK upgraded across the board** — `ai` 7.0.15 and the latest provider adapters (xAI, Google, Groq, Mistral, DeepSeek, Cerebras, MCP). Verified against a live provider that tool-input streaming (the v0.9.6 fix) still works on the new versions.

## [0.9.6] - 2026-07-05

### Fixed

- **The pending tool box now actually appears while write/edit input streams — the real fix.** An AI SDK v7 field rename (`toolCallId` → `id`, `inputTextDelta` → `delta` on tool-input stream parts) was read through casts, so it never failed the build: every tool-input-start event carried an undefined id, the UI dropped it, and the box for write/edit only appeared once the complete call arrived — on every provider, since the v6→v7 upgrade. Verified end-to-end against a live provider this time. Note: how early the box shows still depends on the provider — Anthropic/OpenAI stream tool arguments token by token (the preview grows live); xAI's composer sends each call's arguments in one chunk shortly before the call completes, so the pending window there is inherently brief.

## [0.9.5] - 2026-07-05

### Fixed

- **Streaming write/edit no longer freezes the box in expanded tool view.** The live preview re-rendered on every input token, and expanded mode syntax-highlighted the entire content-so-far each time — on large files the pending box never painted until the input finished streaming. Rendering now coalesces behind a ~50ms flush, and the expanded preview highlights only the last 200 lines while streaming (the completed call still shows everything). The grey box now appears the moment the call starts, in both views.

## [0.9.4] - 2026-07-05

### Changed

- **`edit` streams its replacement text live, like `write`.** The edit box previously sat empty until the whole call finished (its nested input defeated the partial-JSON parser); the replacement text now fills the box as it streams, and the red/green diff still takes over when the call completes.

## [0.9.3] - 2026-07-05

### Added

- **Subagents can be continued — `follow_up`.** When an earlier task's report is missing a detail, the model no longer relaunches from scratch and re-pays the whole discovery run: passing `follow_up` with the earlier task call's id resumes that subagent with its prompt and full activity replayed as context (chains of follow-ups included). A stale id fails soft — the run starts fresh with a visible warning in the box.
- **Task boxes show what a run costs, live.** While a subagent works, its box title ticks `tool · step N · 41s · $0.0123` (elapsed time keeps ticking even when the provider is silent); a finished box reads `done · 12 steps · 41s · $0.0430`. Steps, duration, and the USD-stamped usage persist on the session entry, so `/resume` replays the same figures.
- **A stalled subagent aborts itself instead of hanging forever.** If the provider streams nothing for `subagentStallSeconds` (default 180, 0 disables) while a subagent is waiting on it, the run aborts with a visible `[stalled connection]` note; completed steps stay billed, the partial run persists, and the parent is told it can `follow_up` to continue from the partial work. The watchdog disarms while the subagent's own tools execute, so a long build can't false-trip it.
- **Reasoning tokens can carry their own price.** Some models (the Qwen family among them) bill reasoning output at a different rate than text output — up to several times higher. The catalog now ingests that rate from models.dev and the pricing math splits the output bill accordingly; models without a separate rate are priced exactly as before.
- **Ask-tool quality of life.** Digits 1–9 pick or toggle options instantly; Tab selects the highlighted option and attaches a short typed note to it (the note reaches the model as a clarification of the choice); in multi-select the cursor now starts on the first option instead of the confirm row, with `done` moved last.

### Changed

- **Esc in an ask prompt skips only that question.** Previously Esc on question 1 of 3 silently declined all three; the remaining questions now still show. Aborting everything stays on the turn interrupt (Ctrl+C / Esc on the turn).
- **A subagent handed a prompt with no instruction now says so** — one cheap bounce-back asking the main agent to re-issue the task, instead of inventing a plausible-sounding task and spending a whole run investigating it.

### Fixed

- **Aborting a turn mid-subagent no longer leaks the task box's ticker timer.**

## [0.9.2] - 2026-07-05

### Changed

- **The whole product is rename-ready.** Every brand-derived value — the `~/.loop` config dir, `<cwd>/.loop` project dir, all `LOOP_*` environment variables, the `loop://` docs scheme, the `"loop"` extension-manifest key, CLI usage text, OAuth client names, the user-agent — now flows from a single `brand.ts` per package instead of being hardcoded in ~90 files. A future rename is a three-line constant edit plus the `RENAME.md` playbook; config and extensions migrate automatically (as `.pi` → `.loop` once did).
- **The session database is now `agent.db`.** The filename is deliberately brand-free so renames never touch it. Your existing `~/.loop/loop.db` is adopted in place on first launch (an atomic rename, WAL/SHM sidecars included) — all sessions, cost history, trust decisions, and reminders carry over.
- **Faster cold start, correct migration ordering.** Config stores no longer touch the disk at import time (configstore eagerly wrote its defaults file on construction), which both keeps `--help`/`--version` disk-free and fixes an ordering hazard where the config dir could spring into existence before the legacy-dir migration check ran.

## [0.9.1] - 2026-07-05

### Added

- **The session database heals itself.** If `~/.loop/loop.db` fails its integrity check — or is too damaged to even open — loop now sets the damaged file aside (kept as `loop.db.corrupt-<timestamp>` for forensics), starts a fresh database, salvages every readable row from the damaged one, and re-imports your retained JSONL transcripts to fill whatever couldn't be read. Your frozen pre-ledger cost baseline is carried over too. Previously a corrupt database was only logged and you ran on it anyway.

### Changed

- **Auto-compaction now counts the whole request.** The context estimate that decides when to compact previously ignored the system prompt and tool definitions — 10–20k tokens with workspace context and skills loaded — so compaction could kick in later than it should and a long turn could hit the window. The same honest estimate now also anchors interrupted-turn cost estimates.
- **Cleaner output: no more emoji and icon prefixes.** The `✓`/`✗` prefixes on login, MCP, extension, and cost-audit messages are gone, as is the gear on hook lines — color already says what happened. Recaps now read `※ recap: …`, and `/steak` keeps its 🥩 (the pun is the feature).
- **Long sessions walk their history faster** — the transcript branch walk was accidentally quadratic in session length; it's linear now.

## [0.9.0] - 2026-07-05

### Added

- **Every dollar is now on the record — the cost ledger.** Each billed API round-trip (turn step, subagent step, recap, compaction, branch summary) writes one append-only row with the exact token quantities, the per-MTok prices it was computed from, and the resulting USD. Resuming a session shows the dollars it was billed live — never a re-price against today's catalog — and `/cost`'s lifetime/today/7-day/month/per-folder views are sums over these rows, so two loop instances always see each other's spend instantly. Your pre-existing totals carry over exactly: the old cost.json is frozen in as a baseline, and old sessions get backfilled rows so reopening one still shows a sensible figure.
- **Compaction and branch summaries are billed now.** Both make real API calls that were previously invisible to cost tracking; they now record their spend and stamp their usage on the transcript.
- **`loop cost audit`** — verifies the ledger reconciles: every row's quantities × its price snapshot must reproduce its recorded USD, and per-session ledger sums must match the transcripts. Exits non-zero on any discrepancy, so you can put it in a cron.

### Changed

- **Everything session-adjacent now lives in one SQLite database.** Folder trust decisions (`trust.json`), per-project model memory (the `projectModels`/`projectProviderModels` settings keys), and reminders (`reminders.json`) migrate automatically into `~/.loop/loop.db` on first launch — completing the storage move v0.8.0 started. The old files stay on disk untouched as a downgrade path; the two settings keys are removed so settings.json stops accumulating directory lists. No behavior changes: trust prompts, `/model` memory, and reminders work exactly as before.
- **`/steak` counts only real tokens.** Interrupted-turn estimates (the `~` amounts `/cost` never bills) no longer inflate the daily heatmap.
- **Faster startup on big databases.** The full integrity scan now runs only after an unclean exit instead of on every launch.

### Fixed

- **Recap boxes survive resume.** Persisted recaps were double-wrapped on reload and silently disappeared from replayed sessions.
- **Delegation-only turns no longer lose their cost.** A step whose only output was a task (subagent) call dropped its usage on resume — undercounting session cost and `/steak`.
- **Auto-compaction can no longer break the next request.** A compaction cut that landed on a tool result orphaned it from its tool call, and the next Anthropic request failed with a 400.
- **The session database is checkpointed on exit**, so the write-ahead log no longer grows unbounded across long-running sessions.
- **Old sessions imported from headerless transcripts** stored a mangled directory slug as their working directory and never appeared in `/resume` for that folder.
- **Concurrent RPC sessions no longer share read-before-edit state** — one session's file reads can't unlock edits for another.
- **`/cost`'s 7-day window is DST-safe**, and a sync extension middleware returning a Promise from `onProviderOptions` can no longer corrupt the request options.

## [0.8.5] - 2026-07-04

### Added

- **Subagents can run on their own model — including a different provider.** Give any agent a `model:` line in `~/.loop/agents/<name>.md` (or set it from `/agents` → the agent → `model:`), and every task-tool run of that agent uses it: drive the session on a big model, fan exploration out to a cheap fast one. A new `subagentModel` setting in `/settings` sets the default for all subagents that don't pick their own; unset = inherit the parent's model, exactly as before. Built-ins (`plan`, `data-analyst`, `default`) accept a model via their override file too. Fail-soft by design: if the configured model isn't in the catalog or its provider isn't logged in, the subagent runs on the parent's model and says so at the top of its task box — a stale agent file never bricks delegation. Cost tracking follows the model that actually ran.
- **Bash approval prompts — an opt-in permission gate, like Claude Code's.** Turn on `bash approval` in `/settings` (default off) and every bash command pauses for you first: **allow once**, **always allow**, or **deny** (Esc denies). "Always allow" remembers a scoped pattern — `git status`, `npm install`, bare `ls` — in a new `bashAllow` list you can manage from `/settings` → bash allowlist. Matching reuses the denylist's command parser, so a compound like `ls && rm -rf /` still prompts even with `ls` approved, and `sudo`/`sh -c`/`$( )` can't smuggle a command past you. The denylist still wins over everything; a deny tells the model you declined this command this time, so it continues without hunting for workarounds. Interactive mode only — `loop run` and RPC behave exactly as before. Subagent bash calls go through the same gate.
- **Custom providers can sign in with OAuth.** The `/login` custom wizard gains an **OAuth (browser sign-in)** option for gateways fronted by an authorization server: endpoints are discovered from the base URL (RFC 8414 / OIDC well-known), the client registers itself dynamically (RFC 7591) when allowed, and the PKCE browser flow falls back to paste-the-code for headless/remote sessions. Tokens live in the auth store and refresh automatically — including on servers that omit `refresh_token` from refresh responses, which previously forced a re-login every launch. Explicit `issuer`/endpoints/`clientId`/`scopes` remain available as escape hatches for servers without discovery or anonymous registration.
- **`/alias` — your own shorthand commands.** `/alias s /model claude-sonnet-5` makes `/s` do exactly that; `/alias` lists, `/alias rm <name>` deletes. Aliases persist in settings, expand with any extra arguments appended, can chain into other aliases (cycles are cut off safely), and can never shadow a real command — if a later version claims your alias's name, the built-in wins.

## [0.8.4] - 2026-07-04

### Fixed

- **Resumed sessions now show their true historical cost.** Previously the session total was re-priced on every resume against whatever model catalog the current machine had — so resuming on a laptop that didn't know the model (or after switching to a cheaper/free one) could show `$0.00` for a session that really cost money. Every assistant turn and subagent run now records the USD it was actually billed at, with the full split (input / output / cache read / cache write), and resume reads that instead of re-pricing. Old sessions without the stamp keep the previous catalog-based fallback, so nothing breaks — their totals just stay as accurate as before, while everything from this version on is exact forever, on any machine.

## [0.8.3] - 2026-07-04

### Added

- **Amazon Bedrock support — zero login.** If your machine is signed into AWS (aws CLI profiles, SSO, or env keys), the new `bedrock` provider appears automatically in `/provider` and `/model` with the models **your account can actually invoke** in the region — cross-region inference profiles (`us.anthropic.claude-…`) plus on-demand foundation models, fetched live from Bedrock and cached for an hour. Pricing and context windows are inherited from the underlying vendor model, so cost tracking stays real for Claude/Mistral/etc. Region comes from `AWS_REGION` / `AWS_DEFAULT_REGION` / your profile (override with `LOOP_BEDROCK_REGION`); `AWS_BEARER_TOKEN_BEDROCK` API keys work too. `/login bedrock` verifies the setup and tells you what's wrong when it isn't (no credentials, no Bedrock access in the region, no model access granted). Nothing is copied into loop's auth store — inference uses the standard AWS credential chain, so EC2 instance roles also work.
- **Custom providers can now authenticate however your gateway does.** The `/login` custom wizard asks how the endpoint authenticates: classic **API key** (vendor header), **Bearer token** (always `Authorization: Bearer` — gateways with their own tokens), **environment variable** (read at request time, never stored on disk), **key helper command** (shell command whose stdout is the key — vault/SSO short-lived tokens, cached 5 minutes and re-run on 401, Claude Code `apiKeyHelper` semantics), or **none** (headers-only / mTLS / open endpoints). Model discovery uses the same resolved credential, and legacy flat `apiKey` configs keep working unchanged.
- **`write` streams into its tool box live.** The file path and content now render as the model streams them — a big file write shows a growing, syntax-highlighted tail instead of a silent pending box that pops in only when the call completes.

### Changed

- **The `ask` tool asks better questions.** Its guidance now spells out when a question is warranted (a decision only you can make) versus what it must resolve itself (facts in the code, conventional defaults), and it always puts its recommended option first, labeled " (Recommended)".

## [0.8.2] - 2026-07-03

### Added

- **The agent can now ask you questions mid-turn — new `ask` tool, off by default.** Toggle "ask user (questions tool)" in `/settings` (or set `"askUser": true` in `~/.loop/settings.json`) and the model can pause a turn to ask up to 4 multiple-choice questions when it genuinely needs a decision — which approach to take, what scope you meant. Each question is an arrow-key menu with a topic chip, per-option descriptions, and an automatic **Other** entry that opens a free-text editor for a custom reply; multi-select questions toggle with Enter/Space and confirm via a `done` row. Esc skips the question (and any remaining ones) and the turn simply continues — the model is told you declined and proceeds on its own judgment. The tool is never offered in `loop run` / non-interactive mode, and subagents and restricted agents don't get it unless their tool list names `ask`.

### Fixed

- **Esc no longer kills the whole turn while a menu or prompt is open mid-turn.** Previously the busy-turn Esc-to-interrupt handler ran before any open selector saw the key, so extension `api.ui` menus opened during a turn could never be cancelled without aborting everything. Esc now reaches the focused menu (cancel/skip); Esc during plain generation still interrupts as before.

## [0.8.1] - 2026-07-02

### Added

- **Ctrl+G sends "continue".** The resume-after-interrupt ritual — reopen the session, type `continue`, hit enter — is now one keystroke. Fires only while the agent is idle and the prompt has focus, goes through the normal submit path (hooks, transcript, queue all behave as if you typed it), and is listed in `/hotkeys`.

## [0.8.0] - 2026-07-02

### Changed

- **Sessions now live in a single SQLite database (`~/.loop/loop.db`) instead of one JSONL file per transcript.** On first launch, every existing transcript is migrated automatically — your sessions, names, branches, and usage history all come along, and `/resume` ordering is preserved. The original `.jsonl` files are **left untouched on disk**, so downgrading to 0.7.x just works (sessions created on 0.8.0 won't appear there, but nothing is lost or rewritten). This retires the whole class of file-corruption bugs patched over the last releases — torn-tail writes, per-append lockfiles, cross-process lost updates — by construction: appends are transactions, `/resume` is an indexed query instead of a directory scan, and two loop processes can write concurrently under WAL. `/export` and `/import` still speak JSONL, unchanged.

## [0.7.19] - 2026-07-02

### Fixed

- **A crash mid-write can no longer corrupt the next message you send.** If loop (or the machine) died halfway through appending a transcript entry, the file was left with a torn final line and no trailing newline — and the _next_ append glued its JSON straight onto that fragment, so one crash silently destroyed a second, perfectly valid entry. Appends now check the file tail under the write lock and start on a fresh line, keeping the torn fragment isolated (recovery already skips it). Relatedly, a single corrupt line no longer hides an entire session from `/resume` — the picker now skips the bad line the same way session loading does, instead of dropping the whole transcript from the list.
- **Cost tracking is now safe across concurrent loop instances and corrupt stores.** Two sessions running at once could silently erase each other's lifetime/daily spend (each accumulated onto its own stale cache and rewrote the whole file); every write now re-reads the store first. A corrupted number in `cost.json` used to turn the lifetime total into `NaN` forever; stored values are now sanitized on read. Also fixed on resume: a step's usage could be double-billed if it produced two assistant messages, and the context meter adopted a _subagent's_ context size when the transcript ended on an aborted task — it now tracks the main conversation's last turn. (And the test suite no longer writes into your real `~/.loop/cost.json`.)
- **Extension installs fail fast and load reliably.** `loop install owner/repo#branch` actually installs that branch now (the `#ref` was silently dropped — you always got the default branch); incompatible or broken extensions are rejected at install time with the reason, instead of surfacing as a cryptic warning next session; the API compat check now treats 0.x minors as breaking (an extension built for API 0.1 no longer loads on the 0.3 host and misbehaves at runtime); a hung registry can no longer wedge `loop install` forever (5-minute timeout, and the installer's output now appears in error messages); crashed installs no longer leave `.staging-*` junk behind; and `/reload` genuinely reloads an edited extension — the module cache is busted per load, where before it silently re-activated the old code.
- **Extension host cleanups:** load warnings are replaced per reload instead of accumulating duplicates forever; overriding a built-in command no longer wipes the fields your override didn't specify (e.g. its description); and the extensions/settings stores re-read from disk before each write so two loop processes can't clobber each other's records.

### Added

- **`loop rpc stop`, and a daemon that cleans up after itself.** The socket daemon now removes its socket and pid file on SIGTERM/SIGINT, refuses to start when another live daemon already owns the pid file instead of silently stealing its socket, and `loop rpc stop` (previously "not implemented") terminates it via the pid file. Requests also wait for startup (extensions, commands) to finish, and sending to a session that already has a turn running is rejected cleanly instead of interleaving two turns into the same transcript.
- **`LOOP_DEBUG=1` breadcrumbs.** Errors loop deliberately swallows (best-effort persistence, corrupt-line skips) now leave a trace in `~/.loop/debug.log` when enabled — a failed transcript write was previously invisible, full stop.

### Changed

- **Session housekeeping is faster.** The `/resume` list no longer re-reads and re-parses every transcript on every open (per-file cache, invalidated by mtime — an append always busts it), and each turn step now persists all its messages under a single file lock and write instead of locking per message.

## [0.7.18] - 2026-07-01

### Added

- **`loop mcp` — manage MCP servers from the command line, like `claude mcp` / `codex mcp`.** Previously MCP servers could only be added through the interactive `/mcp` panel; you can now add and manage them in one shot from your shell. `loop mcp add --transport http docs https://code.claude.com/docs/mcp` adds a remote server; `loop mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ~/code` adds a local stdio one (everything after `--` is the command, verbatim). Auth follows the usual conventions: `--header "Authorization: Bearer ${env:TOKEN}"` for static-header servers (the `${env:VAR}` placeholder resolves at connect time, so secrets stay out of the config file), `--oauth` for servers that use browser sign-in (then `loop mcp login <name>` runs discovery → consent → token exchange; `--client-id`/`--client-secret`/`--oauth-scopes` cover providers like Figma that block anonymous registration), and `--env KEY=VALUE` for stdio environments. `--scope user` (default, `~/.loop/settings.json`) or `--scope project` (`./.loop/mcp.json`, shareable via the repo). Rounded out with `list`, `get`, `remove`, `enable`/`disable`, `login`, and `add-json`.

### Fixed

- **The `/tree` view now renders tool steps legibly.** Tool rows previously showed an empty `[tool]:` and tool-call turns read as `assistant: (no content)`, because a tool result only stores a `toolCallId` reference and the renderer only knew how to display plain text. Each tool result now resolves back to its originating call and shows the same one-line summary as the live view — `read src/foo.ts`, `bash git status`, `grep TODO in src` — so a session's tool activity is readable and, crucially, you can once again see clearly where a branch was taken (the connector art was always there; it was just surrounded by blank rows). Tool rows are also searchable by tool name and arguments now.

### Changed

- **The `loop rpc` JSON-RPC server now streams the full turn.** It previously forwarded only 7 event types, so a client saw no reasoning/thinking, no subagent activity, no live per-step cost, and tool boxes that appeared late; it now forwards every turn event, and the list is checked at build time so it can't silently fall behind again. Added a `session.history` method (transcript replay for reconnecting clients) and a `server.info` capabilities handshake.

## [0.7.9] - 2026-06-28

### Added

- **`/steak` — a GitHub-contributions-style heatmap of your token usage.** A calendar wall of one square per day, shaded by total tokens (input + output) consumed, with relative quartile intensity so it reads the same whether you burn 10k or 10M a day. It's reconstructed from your session transcripts on disk, so the graph is full of history on first run rather than starting blank. `/steak` shows the trailing 52 weeks; `/steak <year>` (e.g. `/steak 2026`) shows a specific calendar year as a complete frame, with not-yet-happened days drawn as empty cells to fill in. The same heatmap now also leads the `/cost` output (trailing year), above the dollar breakdown.

## [0.7.7] - 2026-06-27

### Fixed

- **`/reload` now actually picks up MCP server and settings changes from disk.** The "hard reload" claimed to re-read every config surface but silently served stale data: it never refreshed the cached `settings.json` (the in-memory `CachedStore` is only invalidated via `refresh()`, which nothing called), and it never touched MCP at all. So servers added, removed, or edited in `settings.json` stayed invisible after `/reload`, and theme / `mcp` toggle / user-level hook edits made directly on disk were ignored — every `getSetting()` kept returning the value cached at startup. `/reload` now drops the settings cache first (so theme, hooks, MCP gating, and the server list all re-read from disk) and tears down + reconnects MCP (`close()` resets the manager so `init()` runs again instead of no-op'ing on its already-initialized flag). MCP reconnects in the background, same as the `/settings` mcp toggle.

## [0.7.6] - 2026-06-27

### Fixed

- **No more stray escape sequences in the shell after an interrupted exit.** The terminal-restore on teardown (kitty keyboard protocol + modifyOtherKeys) only ran on loop's normal exit path, so an _uncaught_ `SIGINT` — exit code 130, e.g. a Ctrl+C that lands during startup, while a child process owns the terminal, or forwarded by a parent like `bun run dev` — killed the process before the reset ran, leaving the protocols enabled and the shell echoing raw escapes like `^[[27;5;13~` on the next keypress. The TUI now installs a synchronous exit/signal safety net (`exit`/`SIGINT`/`SIGTERM`/`SIGHUP`) that restores the terminal via `fs.writeSync` even when the normal teardown never runs, then exits with the conventional `128+signo` status. (The earlier v0.7.1 fix made the reset unconditional but couldn't help when teardown wasn't reached at all.)

## [0.7.5] - 2026-06-27

### Added

- **Tool calls show a pending box the moment they start, then resolve to done.** Previously a tool with a large input — most visibly `write` (the full file content) and `edit` (the old/new strings) — only appeared once its entire input had finished streaming, so it popped in late instead of reading as in-progress. Every tool now renders a pending (grey) box as soon as the call begins (on the AI SDK's `tool-input-start`), fills in its arguments when they arrive, and turns green on completion — consistent across all tools.

### Fixed

- **`bash` commands can no longer run unbounded.** The timeout was optional with no default, so a command run without one — a hung process, a server left in the foreground — could run forever (in one case 30+ minutes). Bash now defaults to a **120-second** timeout, capped at **600 seconds**; the model can still request a longer timeout up to the cap for builds or installs. On timeout (or interrupt) the entire process tree is SIGKILLed, so nothing is left running in the background.

## [0.7.4] - 2026-06-27

### Changed

- **The thinking level now sits right after the model in every status-line layout.** It was previously scattered — after the context bar in `compact`, mid-dashboard in `vitals`, at the very end in `tokens`/`minimal` — and the `bar` layout omitted it entirely. Every layout (`compact`, `vitals`, `tokens`, `flex`, `powerline`, `minimal`, `bar`) now places it immediately next to the model. It stays gated on whether the model actually reasons and a non-off level being selected, so non-reasoning models (e.g. `composer-2.5`) still show nothing.

### Fixed

- **Errors now surface the real failure code instead of collapsing to a vague message.** loop reads the underlying syscall code — `EPERM`, `ECONNREFUSED`, `ENOENT`, `ETIMEDOUT` — and shows it like `fetch failed (ECONNREFUSED)`, walking the `.cause` chain that Bun/Node bury the real error inside (a flat read missed it). Machine-level failures (blocked permissions, refused network) are now diagnosable instead of reading as "unknown error". Provider/HTTP-status error formatting is unchanged.

## [0.7.3] - 2026-06-26

### Fixed

- **The `vitals` status-line layout no longer bloats memory.** Its background sampler spawned a `pmset` subprocess on every 1-second tick to read the battery level. Under Bun a per-second child-process spawn keeps inflating the allocator's high-water mark — RSS that's never returned to the OS — so a session sitting on the `vitals` layout crept from the usual ~50–60 MB up to ~190–200 MB. Battery has been removed from the dashboard entirely; the sampler is now a pure in-process read (`cpu` · `mem`) and never spawns a subprocess, keeping the layout at baseline memory.

## [0.7.2] - 2026-06-26

### Fixed

- **Reopened sessions no longer lose most of a turn's content.** A turn that used a tool (so the model answered across multiple steps) only ever persisted its first step — the final answer, and its token usage, were dropped on the way to disk. Reopening the session (or even the next turn in it) showed the turn truncated to the tool call. Every step's messages are now persisted, so the full turn survives a reopen and feeds back into the model's context intact.
- **Interrupting a response is now remembered.** When you interrupt mid-answer, the partial response is kept and the turn is marked interrupted, so the next turn's context tells the model its previous answer was cut off instead of silently dropping it. The `interrupted` flag (and the per-message model stamp used for cost) now survive a reload from disk.
- **Interrupted responses are no longer billed at $0.** The model provider charges for the input and the partial output of a request you interrupt, but the SDK reports no usage on abort, so loop counted it as free. The interrupted request's cost is now estimated — output from the partial text, input anchored to the adjacent real step's actual token/cache split — added to the session total (never the persistent lifetime/daily totals) and shown with a leading `~` so it reads as an estimate.

## [0.7.1] - 2026-06-26

### Added

- **Status-line layouts in the `statusline-themes` extension.** Beyond recoloring, the built-in now offers full custom layouts via `/statusline`: `compact` (model · context bar · tokens), `vitals` (a live dashboard with ctx% · tokens · cached · cache-hit% · cost · clock · cpu · mem · battery), `tokens` (in/out/cached/total economics), `flex` (a three-row powerline dashboard), `powerline`, `minimal`, and `bar`. Color themes (now `/statuscolor`) compose on top of any layout. Every layout leads with the selected agent and the model, gates the thinking level on whether the model actually reasons, and is responsive — dense layouts wrap onto extra rows and others shed lowest-priority segments so nothing runs off a narrow terminal.
- **`api.statusLine.refresh()`** lets an extension request a repaint for live fields (e.g. the vitals clock/CPU) that change without user action; no-op in print mode. `StatusLineContext` gained a `reasoning` flag. Extension API bumped to `0.3.0`.

### Fixed

- **No more stray escape sequences in the shell after Ctrl+C.** On teardown the terminal now resets the kitty keyboard protocol and modifyOtherKeys unconditionally instead of gating on tracked flags, which a fast exit racing the startup negotiation could leave out of sync — stranding modifyOtherKeys enabled so the shell echoed raw escapes like `^[[27;5;13~` on the next keypress.

## [0.6.4] - 2026-06-25

### Fixed

- **"Update available" notice now sits under the welcome banner.** The async update check used to append its line to chat history, so it landed at the bottom (below the conversation) whenever the network resolved. It's now shown as a line in the welcome masthead, and is preserved across `/new` and `/clear`.

## [0.6.3] - 2026-06-25

### Added

- **Extensions can drive interactive UI and auth.** New `api.ui` (`select` / `search` / `prompt` / `note` / `error`) gives extensions the same menus/prompts the built-in panels use, and `api.auth` (`getSecret` / `setSecret` / `openExternal` / `loopbackOAuth`) adds namespaced secret storage plus a localhost OAuth flow — enough to build the whole MCP feature as an extension. `api.ui` throws in non-interactive (`-p`) mode.
- **Customizable status line.** The block under the input box (formerly `CostFooter`, now `StatusLine`) is extensible via `api.statusLine.add(fn)` (append segments to a row) and `api.statusLine.transform(fn)` (rewrite the rendered rows). Contributors get a `StatusLineContext` (agent, model, session, cost, context, cwd, width) and are sandboxed so a throwing extension can't break the render.
- **New built-in extension: `statusline-themes`.** Enable it for a `/statusline` command that opens a searchable menu to recolor the status line — 12 themes including `matrix`, `ocean`, `sunset`, `synthwave`, `fire`, `rainbow`, plus `heat`/`neon`/`gold`/`cyber` adapted from the AKCodez status-line palette. `/statusline <name>` switches directly. Disabled by default.

## [0.6.2] - 2026-06-25

### Fixed

- **Tab is now reserved for completion.** While typing a slash command (or an `@` file reference), Tab completes it. Cycling through agents is now **Shift+Tab** only — plain Tab no longer cycles. This also fixes a bug where pressing Tab on terminals without the Kitty keyboard protocol opened the macOS file picker (Tab and Ctrl+I share the same byte, `0x09`).

## [0.6.1] - 2026-06-25

### Changed

- **Active extensions are visible.** Enabled extensions show in the startup status block (with workspace context) — e.g. `extensions: lsp · ponytail (full) · caveman (full) · rtk (on)` — and reappear after `/new` and `/clear`. Extensions can report a one-line status via `api.extension.setStatus`.
- `rtk` shows `rtk (no binary)` when the `rtk` CLI isn't installed, with `/rtk` linking to the installer.

## [0.6.0] - 2026-06-24

### Added

- **Extensions.** loop now has a JavaScript/TypeScript extension system — write or install extensions that add or override almost everything: slash commands, tools, providers and the models inside them, agents, skills, settings, the system prompt, and the turn loop. Extensions are plain Bun/TS packages (no build step) and may carry their own npm dependencies, resolved by the Bun runtime shipped inside the loop binary.
    - Install from npm, GitHub (`github:owner/repo`), or a local path: `loop install <spec>`, `loop link <path>` (dev), `loop list`, `loop enable`/`disable`, `loop remove`. In-session: the `/extensions` panel and `/install`.
    - Tool control: add/remove any tool (the default agent gets every tool automatically), `onCall` to rewrite or block a tool's input pre-execution, `onResult` to transform its output, and grant a tool to a restricted agent.
    - Providers: register a whole provider plus its models — declarative (OpenAI/Anthropic/Google-compatible) or imperative — appearing in `/model`, `/login`, and cost tracking like a built-in.
    - Turn middleware can shape the system prompt per agent, add/remove tools, and tweak provider options each turn.
    - Authoring guide: `read loop://docs/extensions.md`.
- **Built-in extensions** (pre-installed, disabled by default — enable with `loop enable <name>` or `/extensions`):
    - `lsp` — appends type/lint diagnostics after `write`/`edit` via auto-provisioned language servers.
    - `ponytail` — the "lazy senior dev" persona: write the minimal solution (`/ponytail lite|full|ultra`).
    - `caveman` — ultra-terse replies for fewer tokens (`/caveman lite|full|ultra|wenyan-…`).
    - `rtk` — rewrites bash commands through the `rtk` binary to compress output (no-op if `rtk` isn't installed).

## [0.5.3] - 2026-06-19

### Changed

- **Dropped the `lp` short alias.** `lp` collided with the preinstalled CUPS printer command (`/usr/bin/lp`), so depending on PATH order `lp` could run the printer instead of loop. The command is now just `loop` (with `agent` as the alias). On upgrade, the installer removes any old `lp` symlink and strips the `lp` shell alias a previous version may have added to your shell rc.

## [0.5.2] - 2026-06-19

### Fixed

- **`lp` no longer collides with the system printer.** The short `lp` alias shares a name with the preinstalled CUPS `lp` command (`/usr/bin/lp`); on machines where loop's bin dir sat behind `/usr/bin` in PATH, typing `lp` ran the printer instead of loop. The installer now adds an `lp` shell alias as a fallback when its symlink doesn't win the PATH lookup, and the install summary only advertises the command names that actually resolve to loop on your machine.

## [0.5.1] - 2026-06-18

### Added

- **Animated welcome banner.** Startup now shows a masthead with a pixelated `loop` ring on the left — a bright "comet" head chases its way clockwise around the square (corners filled), spins for two rotations, then settles into a static hollow ring that reads as a loop. Beside it: the greeting, model · session · agent, cwd, and the tips line. The banner also re-appears on `/new` and `/clear`, which previously left the screen empty.

## [0.5.0] - 2026-06-18

### Changed

- **Renamed `pi` → `loop`.** The command is now `loop`, with `lp` (short alias) and `agent` also starting it. Config moved from `~/.pi` to `~/.loop`, and all `PI_*` environment variables are now `LOOP_*` (`LOOP_KEY`, `LOOP_DIR`, `LOOP_MCP_*`, `LOOP_SANDBOX_*`, `LOOP_FROM_SOURCE`, …). Package names are now `@notshekhar/loop{,-core,-tui,-sandbox}`.
- **Automatic, lossless config migration.** On first run, an existing `~/.pi` from a pre-0.5.0 install is moved to `~/.loop` (copied, then the old dir removed only after the copy succeeds) so auth, sessions, and settings carry over with no loss. Handled by both the installers and the app itself, so npm/source/binary installs are all covered.
- Build is now pure Bun — dropped the `tsc` declaration-emit step (and the `typescript` dependency); `bun build.ts` handles every package.

### Removed

- Dropped upstream `pi`-session compatibility: the `piCompatMode` setting and its special fork-on-open handling are gone. `loop` reads and writes its own sessions only. (The `/fork` command and per-entry forking are unaffected.)

## [0.4.5] - 2026-06-18

### Added

- Global instructions: `~/.loop/AGENTS.md` and `~/.loop/CLAUDE.md` are now loaded into workspace context in every session, regardless of the working directory — mirroring Claude's `~/.claude/CLAUDE.md`. Previously context files were only read from the cwd up to the repo root, so there was no place for user-wide rules. pi writes `AGENTS.md` by default, but a user-authored global `CLAUDE.md` is honored too. Workspace `AGENTS.md`/`CLAUDE.md` files still apply on top.

## [0.4.4] - 2026-06-18

### Added

- xAI **Composer 2.5** (`xai/composer-2.5`) is now in the model catalog — xAI's agentic coding model. It's callable via the xAI API even though it isn't listed by `/v1/models` (subscription/preview).

### Changed

- The thinking level is now hidden for models that don't reason. composer-2.5 reasons internally but rejects the `reasoningEffort` parameter, so the footer no longer shows a thinking level and `/thinking` reports "current model does not support thinking" — matching pi-mono, which gates both on the model's `reasoning` capability. (Also applies to other non-reasoning models like grok-3.)

## [0.3.51] - 2026-06-17

### Added

- The `read` tool now shows its line range in the tool title when called with `offset`/`limit` (e.g. `read src/app.ts:200-249`), so partial reads of large files are visible at a glance — matching pi-mono.
- README now documents the bash OS sandbox (the `sandbox` setting: network/filesystem boundaries, fail-open for normal agents vs. fail-closed for the read-only `plan` agent) and the bash denylist (`bashDeny`, wrapper/`sh -c`/substitution resolution, guardrail-not-a-sandbox).

### Changed

- Internal clean-up with no behavior change: the interactive app orchestrator and turn runner were split into focused modules (footer refresh, working indicator, ticker, turn-emitter wiring, subagent streaming), and a dead duplicated copy of the tool utils was removed.

## [0.3.50] - 2026-06-17

### Added

- OS-level sandbox for the bash tool, in a new `@notshekhar/loop-sandbox` package (ported from anthropic-experimental/sandbox-runtime, Apache-2.0). On macOS it generates a Seatbelt profile and runs commands under `sandbox-exec`; filesystem writes are confined to the working directory (+ temp), and network is deny / allow / per-domain allowlist (HTTP + SOCKS5 filtering proxies). Off by default — enable via `sandbox` in `~/.loop/settings.json`. Fails open with a warning for normal agents when it can't be enforced. (Linux bubblewrap + socat bridge + seccomp are written but UNVERIFIED; Windows is a stub.)
- The plan agent now gets the `bash` tool for read-only investigation — but only where the OS sandbox can enforce it (macOS/Linux). Its bash is forced into a fail-closed, kernel-enforced read-only sandbox (no writable cwd), so it physically cannot mutate the filesystem; on platforms without sandbox support, bash is withheld entirely. The same guarantee applies to any agent (or subagent) allowed bash but not write/edit.
- `/bashdeny` — an interactive, searchable UI to add/remove bash commands the agent is refused, also reachable from `/settings` ("bash denylist"). No more hand-editing JSON.

### Changed

- An unrecognized `/command` is now treated as a normal message to the model instead of erroring (fall-through), so messages that merely start with `/` just work.
- The bash denylist refusal is now a short 2-3 line message framed as the user's intentional policy. Denylist entries are plain command strings (the per-entry `reason` field was removed); legacy `{pattern,reason}` entries in existing settings are tolerated and migrated to strings on next edit.

## [0.3.49] - 2026-06-17

### Fixed

- The bash denylist now sees through command wrappers and proxies, closing the easiest bypass. `rtk git commit` (and `rtk proxy git commit`), `sudo`/`env`/`xargs` prefixes, interleaved `VAR=value` assignments, and inline `sh -c "…"` / `bash -c "…"` scripts all resolve to the real command before matching — so `rtk git commit` is blocked just like `git commit`. This raises the bar against accidental and lazy evasions; it is still a guardrail, not a sandbox, and a determined model can defeat string matching by design.

## [0.3.48] - 2026-06-17

### Added

- Configurable bash command denylist (`bashDeny` in `~/.loop/settings.json`). Entries match by command name, optionally plus a subcommand prefix (`"git commit"` blocks `git commit -m …` but not `git status`); a `{ "pattern": …, "reason": … }` form attaches guidance the agent sees. Matching resolves full paths to their basename (`/bin/rm` → `rm`), looks past leading env assignments and wrappers (`sudo`, `env`, `xargs`, …), and scans every command in a pipeline or `$(…)` substitution. When blocked, the agent gets a refusal framed as a deliberate user policy — naming the command and explicitly ruling out workarounds — so it stops and redirects instead of hunting for an equivalent. Defaults to blocking `git commit` and `git push` (commit/push stay with the human); set the key to `[]` to allow everything. This is a guardrail, not a sandbox — bypassable by a determined model, by design.

## [0.3.47] - 2026-06-17

### Changed

- An unrecognized `/command` is no longer rejected with `unknown command`. If the leading `/token` doesn't match a registered slash command, the input falls through and is sent to the model as a normal message — so messages that merely start with a slash (paths, options, off-hand `/notes`) just work. Registered commands, including one-shot `/<agent> <message>`, still run inline as before.

## [0.3.46] - 2026-06-16

### Fixed

- Internal anchor links in rendered markdown (e.g. `[Section](#heading)`) no longer render as broken clickable links. The terminal has no way to act on a `#fragment` target — it would try to "open" it as a URL — and the TUI has no app-owned viewport to scroll, so these now render as plain styled text. External `http(s)`/`mailto:` links are unchanged and still open from hyperlink-capable terminals.

## [0.3.26] - 2026-06-12

### Added

- Searchable model picker: type to filter (substring over id/name/description) — practical for OpenRouter's huge list. `+ add model…` registers any `provider/id` to `~/.loop/models.json`, usable immediately; a wrong id just errors at chat time. Custom models are marked and removable from the picker.
- Subagents are now a fork of the spawning agent by default: same system prompt (including workspace context and skills), same tools (minus `task` — no nesting), fresh context window. The turn's agent is what forks — including one-shot `/<agent> message` turns. Passing `agent` to the task tool still runs a named agent, with its tools capped to the parent's. This replaces the `subagent-tools:` cap config (frontmatter line is ignored if present, the `/agents` cap picker is gone): the parent's own tools are the cap, so delegation can never widen access with zero configuration.

### Fixed

- Subagent reports now actually reach the main agent. The AI SDK invokes `toModelOutput` with an options object (`{ toolCallId, input, output }`); we read the wrapper as the output, so every report degraded to the "(subagent finished without a final response)" placeholder — the main agent would dismiss the run and redo the work itself. Pinned with a regression test matching the SDK's exact call shape.
- Aborting a turn mid-run (Esc) no longer loses its cost on resume: both the main loop and subagent loop keep a per-step usage sum and persist it when the run never reaches `finish`, so a resumed session seeds the real spend instead of $0. (The lifetime/daily store was always abort-safe — it bills per step.)
- Subagent runs on Anthropic-shaped providers (including anthropic-sdk custom gateways) now use prompt caching. The subagent loop sent no `cache_control` breakpoints, so every step re-billed its entire accumulated context at full input price — quadratic in steps; one long run burned 2.4M uncached input tokens (~$7 on Sonnet). The system prompt is anchored once and a moving breakpoint re-anchors the last message every step, so each step re-reads prior context at the 90%-discounted cache price. The same per-step moving breakpoint now also applies to long multi-step main turns.

### Changed

- Subagents no longer bloat the main context: the parent model receives only the subagent's final report (bounded to 24k chars via the AI SDK `toModelOutput` pattern) — never the subagent's intermediate tool calls or file contents. The full activity log stays UI-only.
- Subagent activity is now stored as structured parts (text / reasoning / tool, in stream order) instead of one flat string — display order matches the real run, and renderers can style each kind independently. Old sessions with string activity still replay. The report handed to the parent is the AI SDK's final response text, with a stand-in when the subagent never produced one (abort, tool-only finish).

## [0.3.25] - 2026-06-12

### Added

- The `read` tool now also fetches URLs: pass an `http(s)://` URL and it returns the page as readable text (HTML stripped, truncated, timeout + size caps). Available to every agent that has `read` — including plan and subagents — with no extra tool to wire.
- `/settings → subagents` toggle: master on/off switch for the task tool (subagents). Off → no agent gets `task`.

### Fixed

- Subagent activity log (the streamed `> read …` tool lines) now persists with the run and replays on session resume, above the report — previously only the final report came back.

## [0.3.24] - 2026-06-11

### Added

- Subagent tool caps: every agent now has a second tool config — what the subagents it spawns may use (`subagent-tools:` frontmatter, asked in `/agents` create/edit when task is selected). The cap intersects with the target agent's own tools, so delegation can never widen access (verified: plan's subagents physically have no write/edit/bash even when targeting an unrestricted agent). `task` is now selectable per-agent, and the built-in plan agent can delegate while staying read-only end to end.
- Shift+Tab cycles agents anytime (even with text typed); plain Tab still cycles on an empty prompt and stays autocomplete while typing. Cycle = active custom agent plus all built-ins.
- Read-before-modify enforcement in the tools: `edit` rejects files not read this session and stale edits after on-disk changes; `write` guards overwrites of existing unread files while new files/paths pass freely. Session-scoped — nothing persists, `/new` clears the slate.

### Changed

- Sharper built-in prompts: default agent (verify-before-done working style, scope discipline), plan agent (investigation method + delegation, hard read-only rules), and subagent run rules (self-contained reports, no scope creep, honest partials)

- Performance: cost tracking writes one file per step instead of three (configstore rewrites the whole file per set), hook config merging is cached between events, subagent streaming coalesces repaints on a 50ms tick, and the auto-compact estimate no longer re-stringifies the whole history every turn
- Internals: agent core split into focused modules (subagent, tool-hooks, model-messages, events), turn events and settings access are fully typed (typos fail the build), and a `bun test` suite now covers hooks matching, agent files, cost seeding, compaction context, and changelog parsing (runs in CI)

## [0.3.23] - 2026-06-11

### Added

- Per-project model memory: the last model/provider picked in a folder is restored next time pi starts there (CLI flag and resumed sessions still win; global default remains the fallback). Applies to `pi run` too.
- Live cost, usage, and context: the footer updates after every step (each API round-trip), including subagent steps — and aborted turns keep the cost of completed steps

### Fixed

- Resumed sessions no longer show `$0.0000 · in:0 out:0 · ctx 0` until the next message — cost, token usage, and the context meter are restored from the transcript's usage entries on resume (startup `-s` and `/sessions` alike), without double-billing lifetime totals
- Subagent runs persist in the session: resuming replays the task box (agent, prompt, report), counts the subagent's tokens in the restored cost, and keeps the report in the model's context so it remembers subagent findings across resumes

### Changed

- Subagents run on the AI SDK's native `ToolLoopAgent` (same pattern as the official subagents guide); the task tool returns a plain-text report instead of JSON, expanding the task box shows the full activity log (tool calls with arg summaries) above the report, subagent input rewrites no longer leak into the main chat, and the model is instructed to call `task` alone in its step

## [0.3.19] - 2026-06-11

### Added

- Subagents: the `task` tool lets the main agent launch any named agent (default, plan, customs) for a self-contained job in its own context window — subagent activity streams live inside the task tool's box, usage/cost aggregates into the session totals, tool calls run the same hooks tagged with `agent_id`, and `SubagentStop` hooks fire on completion. Restricted agents (plan) don't get the task tool, and subagents can't nest. `subagentMaxSteps` setting caps the loop (default 50).
- Tab on an empty prompt toggles between built-in agents (default ⇆ plan); hinted in the footer (`agent default (tab ⇆)`), startup banner, and `/hotkeys`. Autocomplete keeps Tab while typing.
- Subagent rendering: the task tool gets a purple box with live state in the title (`task plan read · <prompt>` → `done`/`failed`), streamed activity collapses/expands like any tool output
- Model catalog refreshes at runtime: new models and pricing are re-fetched from models.dev on the hourly stale-while-revalidate cycle and warmed up at startup — release binaries keep learning about new models
- `/reload` is a hard reload: theme, commands, prompts, skills, agents re-read from disk, and the model catalog force-refreshed from the network
- `/hooks` management: lists every loaded hook with its source (pi-user, pi-project, claude-user, claude-plugins, claude-project), adds/removes pi-owned hooks in `~/.loop/settings.json`, and copies imported Claude hooks into pi so they keep working without a Claude Code install

### Fixed

- Anthropic `text content blocks must be non-empty` (400) on sessions with aborted turns: empty assistant messages are no longer persisted, and existing ones are filtered out of the model context on read

## [0.3.17] - 2026-06-11

### Added

- Per-agent tools: pick the allowed tool subset when creating or editing an agent (`/agents`, stored as `tools:` frontmatter in `~/.loop/agents/<name>.md`); the model only receives the allowed tools, and the system prompt lists exactly what's available
- `/plan` built-in agent: read-only planning agent (read, ls, grep, find) that explores the codebase and produces step-by-step implementation plans without being able to modify anything; prompt overridable like default, tool set fixed
- Built-in agents show their fixed tool set everywhere (agent list, action menu, edit flow) — visible but not editable
- Toggle-style multi-select for the tool picker: Enter or Space flips an entry with the cursor staying in place; "done" confirms

## [0.3.16] - 2026-06-11

### Added

- Custom agents: `/agents` creates, selects, edits, and deletes named system prompts (stored in `~/.loop/agents/<name>.md`); each registers as a `/<name>` command, and the built-in default prompt can be overridden and reset
- One-shot agent runs: `/<agent> <message>` runs that single message under the agent's prompt without changing the session's selected agent
- Slash commands highlight cyan in the input as you type, and executed commands echo highlighted into the chat
- Footer split into two rows: active agent + model on top, session/cost/context below

### Changed

- PreToolUse `updatedInput` rewrites (e.g. rtk's bash command compression) update the rendered tool call in place — the chat shows the command that actually executed, instead of a separate hook line
- Hook hardening: dispatcher never throws (corrupt config degrades to a warning), timeouts clamped, hook output capture capped at 1MB, chat-facing hook messages clipped, block decisions are strictly first-wins, Windows uses cmd.exe

## [0.3.15] - 2026-06-11

### Added

- Agent-state watcher support (herdr, Warp, …): `Notification`, `PermissionRequest`, `PreCompact` hook events, `terminalSequence` hook output for TUI-safe OSC notifications, `async` fire-and-forget hooks, parallel hook execution per event, and hook `statusMessage` shown in the loader while running
- `claudeHooksFilter` setting — allowlist which imported Claude Code hooks load (e.g. `["caveman", "herdr", "warp"]`); unset imports everything
- Errors always surface in chat: agent stream errors, slash-command failures, and uncaught exceptions render as red messages instead of disappearing

### Fixed

- `/changelog` and the what's-new banner work in release binaries — changelog content is embedded at build time (standalone binaries ship no CHANGELOG.md on disk)
- Hook `statusMessage` no longer prints a chat line on every prompt; it rides the loader while the hook runs

## [0.3.14] - 2026-06-11

### Added

- Claude Code–compatible lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`) with imports from `~/.claude/settings.json`, project `.claude`/`.loop` settings, and enabled Claude Code plugins (`${CLAUDE_PLUGIN_ROOT}` expansion included)
- Active hooks summary in the startup banner
- `/cost` detailed breakdown: session, current directory, today, last 7 days, this month, lifetime by provider
- Theme setting now applies: `/settings → theme` picks dark, light, or custom `~/.loop/agent/themes/*.json` and switches live
- `/changelog` shows release notes; new entries appear once after an upgrade
- `bun run format` (prettier) for the monorepo

### Changed

- Hook messages render with an orange accent, separate from tool grey/green
- Session-start hook context collapses to a one-line notice instead of rendering inside the first user message

### Fixed

- Hook commands exiting without reading stdin no longer crash the TUI (EPIPE)
- Hook timeouts now kill the whole process group, not just the shell
- Hook payloads match Claude Code field names (`tool_response`, `transcript_path`, `stop_hook_active`, `source`)
- Hook-injected context lands on the latest user message even when images are attached

## [0.3.13] - 2026-06-10

- Releases up to here predate changelog tracking: interactive TUI (`pi`), print mode (`pi -p`), sessions with fork/resume, multi-provider models via Vercel AI SDK v6, auto-compaction, cost tracking, project skills, workspace context
