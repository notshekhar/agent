<!-- title: Built-in extensions -->
<!-- order: 8 -->
<!-- blurb: Language servers, token compression, and personas — bundled with loop, off until you turn them on. -->

loop ships five extensions inside the binary. They are **pre-installed but disabled**, so a fresh install behaves exactly as it always has until you opt in.

```
loop extensions            # list everything, built-in and installed
loop enable <name>         # turn one on
loop disable <name>        # turn it back off
```

`/extensions` does the same from the TUI, and the startup banner shows which are active and how they're configured. Changes take effect on `/reload` or the next start.

| Extension           | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `lsp`               | Type errors after every edit, plus a code-navigation tool |
| `rtk`               | Rewrites bash commands to cut output tokens 60–90%        |
| `caveman`           | Ultra-terse replies, same technical substance             |
| `ponytail`          | "Lazy senior dev" — the smallest change that solves it    |
| `statusline-themes` | Six status-line layouts and a colour picker               |

---

## lsp — language servers

```
loop enable lsp
```

Two halves, and the first one costs you nothing to have on.

**Errors come back with the edit.** After every `write` or `edit`, loop runs the changed file through the language servers that handle it and appends what broke to the tool result:

```
LSP errors detected in this file, please fix:
<diagnostics file="src/main.ts">
ERROR [4:11] Type 'string' is not assignable to type 'number'.
</diagnostics>
```

The agent sees the mistake immediately rather than discovering it later, or not at all. Only errors are reported — warnings are mostly style, and an agent tends to act on everything it is shown. A clean file adds nothing to the transcript.

**The `lsp` tool answers questions grep can't.** Nine operations:

| Operation              | Answers                                   |
| ---------------------- | ----------------------------------------- |
| `goToDefinition`       | Where is this defined?                    |
| `findReferences`       | Everywhere this is used                   |
| `hover`                | What type is this, and what are its docs? |
| `documentSymbol`       | Outline of one file                       |
| `workspaceSymbol`      | Find a symbol across the project          |
| `goToImplementation`   | What implements this interface?           |
| `prepareCallHierarchy` | The callable at this position             |
| `incomingCalls`        | What calls this function?                 |
| `outgoingCalls`        | What does this function call?             |

The difference from `grep` is that answers come from the compiler's model of the program, so a search for a common name doesn't drown in comments, strings, and unrelated symbols that share a spelling — and `incomingCalls` is a question `grep` cannot express at all. Line and character are 1-based, exactly as your editor shows them. The read-only `plan` agent gets the tool too, since navigation is most of what planning does.

### Languages

37 servers covering 75 file extensions:

TypeScript · JavaScript · JSX/TSX · Vue · Svelte · Astro · JSON · YAML · Go · Rust · C · C++ · Zig · Swift · Nix · Java · Kotlin · C# · Razor · F# · Python · Ruby · PHP · Lua · Bash · Elixir · Dart · Julia · Haskell · OCaml · Clojure · Gleam · Terraform · Dockerfile · Prisma · LaTeX · Typst

**TypeScript needs nothing installed.** TypeScript 7 is a native binary that speaks the protocol itself, so loop provisions it on first use and talks to it directly — no `typescript-language-server` wrapper, no Node process in between.

Ten more install themselves on demand (Vue, Svelte, Astro, Python, PHP, Bash, YAML, JSON, Dockerfile, Prisma), and `gopls` installs via `go install` if you already have Go. **Everything else has to be on your PATH.** That's deliberate: `rust-analyzer`, `clangd`, `jdtls` and friends belong to toolchains you manage, and downloading a compiler's language server behind your back is worse than saying it isn't there. If a server is missing, the tool tells you so and the diagnostics half stays quiet.

### How servers are chosen

A project's own `node_modules/.bin` wins over anything global, so you get the version your project pins. Root detection walks up from the edited file to the nearest project marker — a monorepo gets one server per package instead of one confused server for the whole tree. A `deno.json` stands the TypeScript server down. A file can be served by several servers at once (a type checker and a linter say different things); their diagnostics are merged and deduped.

### Adding your own

`~/.loop/servers/servers.json` adds servers or overrides built-in ones, no release required:

```json
{
    "nim": {
        "extensions": [".nim"],
        "languageId": "nim",
        "binNames": ["nimlangserver"],
        "args": [],
        "rootMarkers": ["*.nimble"]
    }
}
```

`runtime` may be `native` (default) or `node` (run under loop's own runtime). Add `npm` + `npmBin` to have loop install it for you.

---

## rtk — fewer tokens from noisy commands

RTK ([rtk-ai/rtk](https://github.com/rtk-ai/rtk)) compresses the output of chatty commands — `git`, `npm`, `cargo`, test runners — by 60–90%. Long build logs and test output are usually the biggest single line item in a coding session, and most of it is padding.

**It needs the `rtk` binary**, which loop does not install. Get it from the project above, then:

```
loop enable rtk
```

That's the whole setup. From then on loop quietly rewrites bash commands before they run — `git status` becomes `rtk git status` — and the model sees the compressed output. Nothing else changes: you don't rewrite your prompts, and the agent doesn't need to know.

| Command       | What                                      |
| ------------- | ----------------------------------------- |
| `/rtk`        | Show whether rewriting is on              |
| `/rtk-toggle` | Turn rewriting on or off for this session |

Which commands get rewritten is rtk's decision, not loop's — loop asks `rtk rewrite "<cmd>"` and uses the answer, so the command table stays in one place and improves when you update rtk. Commands with heredocs (`<<`) are left alone, since line-oriented rewriting mangles them.

**If the binary isn't on PATH the extension is a silent no-op** — bash keeps working exactly as before, and the startup banner shows `rtk · no binary` so you know why nothing is happening. `/reload` after installing it.

---

## caveman — terse replies

```
loop enable caveman
```

Injects a "respond terse, like a smart caveman" persona. Cuts token usage substantially while keeping the technical content — it drops articles and filler, not facts. Useful when you're paying per token and don't need prose.

```
/caveman             # show current mode
/caveman full        # off | lite | full | ultra
/caveman wenyan-full # classical-Chinese variants: wenyan-lite | wenyan-full | wenyan-ultra
/caveman off
```

Saying **"stop caveman"** or **"normal mode"** as a whole message also turns it off. The mode persists across sessions.

---

## ponytail — write less code

```
loop enable ponytail
```

The "lazy senior dev" persona: prefer the smallest change that actually solves the problem, don't build abstractions nobody asked for, don't add options nobody requested. It's aimed at the failure mode where an agent answers a two-line fix with a framework.

```
/ponytail        # show current mode
/ponytail full   # off | lite | full | ultra
/ponytail off
```

**"stop ponytail"** or **"normal mode"** turns it off too. Persists across sessions.

`caveman` shapes _how much it says_; `ponytail` shapes _how much it builds_. They're independent and compose — running both gives you short answers about small changes.

---

## statusline-themes — the bar under the prompt

```
loop enable statusline-themes
```

```
/statusline            # menu of layouts
/statusline vitals     # native | compact | vitals | tokens | flex | powerline | minimal | bar
/statuscolor           # colour menu
```

`vitals` is a dashboard, `tokens` foregrounds context and cost, `powerline` uses separators, `minimal` gets out of the way. The choice persists per install.

---

## Writing your own

Built-in extensions are ordinary extensions — they use the same public API, and their source is a reasonable model to copy. See [Extending](extend.html) for the SDK surface, `loop link` for developing one from a local folder, and `~/.loop/extensions/` for where installed ones live.
