/**
 * The set of language servers this extension knows about. Built-ins live here in
 * code; users add or override entries in ~/.loop/servers/servers.json — no
 * recompile needed. Each entry says how to FIND the server (binNames, looked up
 * in the project's node_modules/.bin then PATH), how to ROOT it (rootMarkers,
 * nearest ancestor wins), and optionally how to INSTALL it when absent.
 *
 * There are three install routes, all lazy and all tried only after the lookup
 * above has failed:
 *
 *   npm       deps provisioned into ~/.loop/servers/<key>/ (see provision.ts)
 *   goInstall `go install` into ~/.loop/servers/bin, gated on `go` existing
 *   download  a prebuilt release archive for this machine (see download.ts)
 *
 * Servers with no install route resolve from PATH only, and that is deliberate
 * where the server is a face of a toolchain the user already manages: fetching
 * our own rust-analyzer next to their rustup one invites a version skew we'd
 * then have to explain. The line we draw is whether the download is a
 * SELF-CONTAINED editor tool (zls, clangd, texlab — downloaded) or part of a
 * compiler the user installed on purpose (rust-analyzer, dart, julia — not).
 *
 * Anything with a `requires` toolchain is checked before we fetch, so a machine
 * with no `java` never downloads jdtls.
 */
import { getConfigDir } from "../../../brand";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { DownloadSpec } from "./download";

export type LanguageKey = string;

export interface LanguageServerDef {
    key: LanguageKey;
    /** File extensions this server handles, lowercase, with the dot. */
    extensions: string[];
    /** Exact filenames it also handles (e.g. "Dockerfile"), compared case-insensitively. */
    filenames?: string[];
    /** LSP languageId, or a function of the path when one server spans several. */
    languageId: string | ((absPath: string) => string);
    /**
     * "node" runs the binary under loop's own runtime; "native" runs it
     * directly; "java" runs `java -jar <bin>`, for servers that are an
     * executable jar rather than an executable (jdtls).
     */
    runtime?: "node" | "native" | "java";
    binNames: string[];
    args?: string[];
    /**
     * JVM flags for `runtime: "java"`. These go BEFORE `-jar` — after it they
     * are arguments to the application, not the JVM, and the system properties
     * jdtls reads its product id from would never be set.
     */
    jvmArgs?: string[];
    /** Files marking the project root; nearest ancestor of the edited file wins. */
    rootMarkers?: string[];
    /** Root markers that DISQUALIFY this server (a deno.json stands typescript down). */
    disqualifyMarkers?: string[];
    /** Binaries that must be on PATH for this server to work at all. */
    requires?: string[];
    /**
     * Minimum major version for a `requires` toolchain, e.g. `{ java: 21 }`.
     * jdtls needs a Java 21 runtime and fails at class-load time on anything
     * older — a check worth paying before a 50MB download rather than after.
     */
    requiresMinVersion?: Record<string, number>;
    /**
     * Minimum MAJOR version a discovered binary must report before we'll speak
     * LSP to it, checked with `--version`. Needed where a long-lived command
     * only grew LSP support recently: `tsc` is TypeScript's compiler and has
     * been on PATH and in node_modules for a decade, but only v7+ answers
     * `--lsp`. Without this the project's own TypeScript 5 gets launched, fails
     * the handshake, and the language dies with it.
     */
    minMajorVersion?: number;
    /** npm deps provisioned into ~/.loop/servers/<key>/ when the binary is absent. */
    npm?: Record<string, string>;
    /** Path to the installed binary within that dir (a JS shim; runs under "node"). */
    npmBin?: string;
    /**
     * Path to a NATIVE binary within the provisioned dir, `{platform}`/`{arch}`
     * substituted from process. Preferred over npmBin when it exists — it skips
     * the JS shim entirely.
     */
    npmNativeBin?: string;
    /** `go install <pkg>` into ~/.loop/servers/bin (needs `go` on PATH). */
    goInstall?: string;
    /** Prebuilt release archive unpacked into ~/.loop/servers/<key>/. */
    download?: DownloadSpec;
}

const NODE_ROOTS = ["package.json", "package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"];

function tsLanguageId(absPath: string): string {
    const ext = extname(absPath).toLowerCase();
    if (ext === ".tsx") return "typescriptreact";
    if (ext === ".jsx") return "javascriptreact";
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
    return "typescript";
}

function cLanguageId(absPath: string): string {
    return extname(absPath).toLowerCase() === ".c" ? "c" : "cpp";
}

const BUILTINS: LanguageServerDef[] = [
    // --- TypeScript / JavaScript ------------------------------------------
    // TypeScript 7 is a native Go binary that speaks LSP itself
    // (`tsc --lsp --stdio`) — no typescript-language-server wrapper and no JS
    // runtime in front of it. The npm package is a thin shim over a
    // per-platform binary, which npmNativeBin resolves to directly.
    {
        key: "typescript",
        extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
        languageId: tsLanguageId,
        runtime: "native",
        binNames: ["tsgo", "tsc"],
        args: ["--lsp", "--stdio"],
        // `tsc` only speaks LSP from TypeScript 7. A project pinning 7+ is used
        // as-is; an older local install is skipped so we provision 7 instead.
        minMajorVersion: 7,
        rootMarkers: ["tsconfig.json", "jsconfig.json", ...NODE_ROOTS],
        disqualifyMarkers: ["deno.json", "deno.jsonc"],
        npm: { typescript: "^7.0.0" },
        npmBin: join("node_modules", ".bin", "tsc"),
        npmNativeBin: join("node_modules", "@typescript", "typescript-{platform}-{arch}", "lib", "tsc"),
    },
    {
        key: "deno",
        extensions: [],
        languageId: tsLanguageId,
        runtime: "native",
        binNames: ["deno"],
        args: ["lsp"],
        rootMarkers: ["deno.json", "deno.jsonc"],
    },
    {
        key: "vue",
        extensions: [".vue"],
        languageId: "vue",
        runtime: "node",
        binNames: ["vue-language-server"],
        args: ["--stdio"],
        rootMarkers: NODE_ROOTS,
        npm: { "@vue/language-server": "^3.0.0" },
        npmBin: join("node_modules", ".bin", "vue-language-server"),
    },
    {
        key: "svelte",
        extensions: [".svelte"],
        languageId: "svelte",
        runtime: "node",
        binNames: ["svelteserver", "svelte-language-server"],
        args: ["--stdio"],
        rootMarkers: NODE_ROOTS,
        npm: { "svelte-language-server": "^0.17.0" },
        npmBin: join("node_modules", ".bin", "svelteserver"),
    },
    {
        key: "astro",
        extensions: [".astro"],
        languageId: "astro",
        runtime: "node",
        binNames: ["astro-ls"],
        args: ["--stdio"],
        rootMarkers: NODE_ROOTS,
        npm: { "@astrojs/language-server": "^2.15.0" },
        npmBin: join("node_modules", ".bin", "astro-ls"),
    },
    {
        key: "biome",
        extensions: [".json", ".jsonc"],
        languageId: "json",
        runtime: "native",
        binNames: ["biome"],
        args: ["lsp-proxy", "--stdio"],
        rootMarkers: ["biome.json", "biome.jsonc"],
    },
    {
        key: "oxlint",
        extensions: [],
        languageId: tsLanguageId,
        runtime: "native",
        binNames: ["oxc_language_server"],
        rootMarkers: [".oxlintrc.json"],
    },

    // --- systems ----------------------------------------------------------
    {
        key: "go",
        extensions: [".go"],
        filenames: ["go.mod", "go.sum"],
        languageId: "go",
        runtime: "native",
        binNames: ["gopls"],
        rootMarkers: ["go.mod", "go.work"],
        requires: ["go"],
        goInstall: "golang.org/x/tools/gopls@latest",
    },
    {
        key: "rust",
        extensions: [".rs"],
        languageId: "rust",
        runtime: "native",
        binNames: ["rust-analyzer"],
        rootMarkers: ["Cargo.toml", "Cargo.lock"],
    },
    {
        key: "clangd",
        extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
        languageId: cLanguageId,
        runtime: "native",
        binNames: ["clangd"],
        args: ["--background-index", "--clang-tidy"],
        rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd"],
        // Ships one build per OS, not per arch (the mac build is universal), and
        // always as a zip. The tag is part of the path inside the archive.
        download: {
            source: { kind: "github", repo: "clangd/clangd" },
            asset: "clangd-{target}-{version}.zip",
            targets: { darwin: "mac", linux: "linux", win32: "windows" },
            format: "zip",
            bin: "clangd_{version}/bin/clangd{exe}",
        },
    },
    {
        key: "zig",
        extensions: [".zig", ".zon"],
        languageId: "zig",
        runtime: "native",
        binNames: ["zls"],
        rootMarkers: ["build.zig"],
        // zls is version-locked to the compiler, so it is only fetched for a
        // machine that already has zig — the same reason gopls requires `go`.
        requires: ["zig"],
        download: {
            source: { kind: "github", repo: "zigtools/zls" },
            asset: "zls-{target}.{ext}",
            targets: { darwin: "{arch}-macos", linux: "{arch}-linux", win32: "{arch}-windows" },
            archs: { x64: "x86_64", arm64: "aarch64", ia32: "x86" },
            format: "tar.xz",
            // Every combo our maps can name exists upstream except 32-bit macOS.
            unsupported: ["darwin-ia32"],
            bin: "zls{exe}",
        },
    },
    {
        key: "swift",
        extensions: [".swift"],
        languageId: "swift",
        runtime: "native",
        binNames: ["sourcekit-lsp"],
        rootMarkers: ["Package.swift"],
    },
    {
        key: "nix",
        extensions: [".nix"],
        languageId: "nix",
        runtime: "native",
        binNames: ["nixd", "nil"],
        rootMarkers: ["flake.nix", "default.nix", "shell.nix"],
    },

    // --- JVM / .NET -------------------------------------------------------
    {
        key: "java",
        extensions: [".java"],
        languageId: "java",
        // Not an executable: an Equinox launcher jar run by the user's own JVM.
        runtime: "java",
        binNames: ["jdtls"],
        rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", ".project"],
        requires: ["java"],
        requiresMinVersion: { java: 21 },
        jvmArgs: [
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Dlog.level=ALL",
            "-Xmx1G",
            "--add-modules=ALL-SYSTEM",
            // One argv element each: `--add-opens a=b` as a single string is
            // read by the JVM as a flag literally named "--add-opens a=b".
            "--add-opens=java.base/java.util=ALL-UNNAMED",
            "--add-opens=java.base/java.lang=ALL-UNNAMED",
        ],
        // {configDir} and {dataDir} are filled in once the archive is unpacked —
        // the config directory is arch-specific and the data directory is a
        // fresh scratch workspace per launch.
        args: ["-configuration", "{configDir}", "-data", "{dataDir}"],
        download: {
            // A rolling snapshot rather than a tagged release; Eclipse publishes
            // no version index for it.
            source: { kind: "static" },
            url: "https://www.eclipse.org/downloads/download.php?file=/jdtls/snapshots/jdt-language-server-latest.tar.gz",
            format: "tar.gz",
            bin: "plugins/org.eclipse.equinox.launcher_*.jar",
        },
    },
    {
        key: "kotlin",
        extensions: [".kt", ".kts"],
        languageId: "kotlin",
        runtime: "native",
        binNames: ["kotlin-ls", "kotlin-language-server"],
        args: ["--stdio"],
        rootMarkers: ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "pom.xml"],
        // Deliberately no download route. JetBrains renamed the artifact to
        // `kotlin-server` and publishes it to their CDN under TWO independent
        // version numbers — the build (262.9593.0, in the GitHub tag) and the
        // vsix (0.0.6, only found by scraping the release notes prose). Nothing
        // in the release JSON yields a URL, so any template we wrote would be a
        // guess that 404s the moment the vsix version moves.
    },
    {
        key: "csharp",
        extensions: [".cs", ".csx"],
        languageId: "csharp",
        runtime: "native",
        binNames: ["csharp-ls", "OmniSharp"],
        rootMarkers: [".sln", ".slnx", ".csproj", "global.json"],
    },
    {
        key: "razor",
        extensions: [".razor", ".cshtml"],
        languageId: "razor",
        runtime: "native",
        binNames: ["rzls"],
        rootMarkers: [".sln", ".slnx", ".csproj", "global.json"],
    },
    {
        key: "fsharp",
        extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
        languageId: "fsharp",
        runtime: "native",
        binNames: ["fsautocomplete"],
        rootMarkers: [".sln", ".slnx", ".fsproj", "global.json"],
    },

    // --- scripting --------------------------------------------------------
    {
        key: "python",
        extensions: [".py", ".pyi"],
        languageId: "python",
        runtime: "node",
        binNames: ["pyright-langserver"],
        args: ["--stdio"],
        rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"],
        npm: { pyright: "^1.1.400" },
        npmBin: join("node_modules", ".bin", "pyright-langserver"),
    },
    {
        key: "ruby",
        extensions: [".rb", ".rake", ".gemspec", ".ru"],
        filenames: ["Gemfile", "Rakefile"],
        languageId: "ruby",
        runtime: "native",
        binNames: ["ruby-lsp", "solargraph"],
        rootMarkers: ["Gemfile", ".ruby-version"],
    },
    {
        key: "php",
        extensions: [".php"],
        languageId: "php",
        runtime: "node",
        binNames: ["intelephense"],
        args: ["--stdio"],
        rootMarkers: ["composer.json", "composer.lock", ".php-version"],
        npm: { intelephense: "^1.10.0" },
        npmBin: join("node_modules", ".bin", "intelephense"),
    },
    {
        key: "lua",
        extensions: [".lua"],
        languageId: "lua",
        runtime: "native",
        binNames: ["lua-language-server"],
        rootMarkers: [".luarc.json", ".luarc.jsonc", ".stylua.toml", "stylua.toml"],
        // Unlike the single-binary servers here, this one needs the meta/ and
        // locale/ trees beside it, so the whole archive stays in place and the
        // binary is used from within it.
        download: {
            source: { kind: "github", repo: "LuaLS/lua-language-server" },
            asset: "lua-language-server-{version}-{target}.{ext}",
            // Upstream happens to use node's own words for both.
            targets: { darwin: "darwin-{arch}", linux: "linux-{arch}", win32: "win32-{arch}" },
            archs: { x64: "x64", arm64: "arm64", ia32: "ia32" },
            format: "tar.gz",
            // 32-bit is a Windows-only build; there is no darwin/linux ia32.
            unsupported: ["darwin-ia32", "linux-ia32"],
            bin: "bin/lua-language-server{exe}",
        },
    },
    {
        key: "bash",
        extensions: [".sh", ".bash", ".zsh", ".ksh"],
        languageId: "shellscript",
        runtime: "node",
        binNames: ["bash-language-server"],
        args: ["start"],
        npm: { "bash-language-server": "^5.4.0" },
        npmBin: join("node_modules", ".bin", "bash-language-server"),
    },
    {
        key: "elixir",
        extensions: [".ex", ".exs"],
        languageId: "elixir",
        runtime: "native",
        binNames: ["elixir-ls", "language_server.sh"],
        rootMarkers: ["mix.exs", "mix.lock"],
    },
    {
        key: "dart",
        extensions: [".dart"],
        languageId: "dart",
        runtime: "native",
        binNames: ["dart"],
        args: ["language-server", "--lsp"],
        rootMarkers: ["pubspec.yaml", "analysis_options.yaml"],
    },
    {
        key: "julia",
        extensions: [".jl"],
        languageId: "julia",
        runtime: "native",
        binNames: ["julia"],
        args: ["--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"],
        rootMarkers: ["Project.toml", "Manifest.toml"],
    },

    // --- functional -------------------------------------------------------
    {
        key: "haskell",
        extensions: [".hs", ".lhs"],
        languageId: "haskell",
        runtime: "native",
        binNames: ["haskell-language-server-wrapper", "haskell-language-server"],
        args: ["--lsp"],
        rootMarkers: ["stack.yaml", "cabal.project", "hie.yaml"],
    },
    {
        key: "ocaml",
        extensions: [".ml", ".mli"],
        languageId: "ocaml",
        runtime: "native",
        binNames: ["ocamllsp"],
        rootMarkers: ["dune-project", "dune-workspace", "opam"],
    },
    {
        key: "clojure",
        extensions: [".clj", ".cljs", ".cljc", ".edn"],
        languageId: "clojure",
        runtime: "native",
        binNames: ["clojure-lsp"],
        args: ["listen"],
        rootMarkers: ["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn"],
    },
    {
        key: "gleam",
        extensions: [".gleam"],
        languageId: "gleam",
        runtime: "native",
        binNames: ["gleam"],
        args: ["lsp"],
        rootMarkers: ["gleam.toml"],
    },

    // --- config / markup / infra ------------------------------------------
    {
        key: "yaml",
        extensions: [".yaml", ".yml"],
        languageId: "yaml",
        runtime: "node",
        binNames: ["yaml-language-server"],
        args: ["--stdio"],
        npm: { "yaml-language-server": "^1.15.0" },
        npmBin: join("node_modules", ".bin", "yaml-language-server"),
    },
    {
        key: "json",
        extensions: [".json", ".jsonc"],
        languageId: "json",
        runtime: "node",
        binNames: ["vscode-json-language-server"],
        args: ["--stdio"],
        npm: { "vscode-langservers-extracted": "^4.8.0" },
        npmBin: join("node_modules", ".bin", "vscode-json-language-server"),
    },
    {
        key: "dockerfile",
        extensions: [".dockerfile"],
        filenames: ["Dockerfile", "Containerfile"],
        languageId: "dockerfile",
        runtime: "node",
        binNames: ["docker-langserver"],
        args: ["--stdio"],
        npm: { "dockerfile-language-server-nodejs": "^0.13.0" },
        npmBin: join("node_modules", ".bin", "docker-langserver"),
    },
    {
        key: "terraform",
        extensions: [".tf", ".tfvars"],
        languageId: "terraform",
        runtime: "native",
        binNames: ["terraform-ls"],
        args: ["serve"],
        rootMarkers: [".terraform.lock.hcl", "terraform.tfstate"],
        // HashiCorp publishes a structured build index, so this is the one
        // server here that needs no filename template at all — we match on
        // (os, arch) fields and take the URL they give us.
        download: {
            source: { kind: "hashicorp", product: "terraform-ls" },
            targets: { darwin: "darwin", linux: "linux", win32: "windows" },
            archs: { x64: "amd64", arm64: "arm64", ia32: "386" },
            format: "zip",
            bin: "terraform-ls{exe}",
        },
    },
    {
        key: "prisma",
        extensions: [".prisma"],
        languageId: "prisma",
        runtime: "node",
        binNames: ["prisma-language-server"],
        args: ["--stdio"],
        rootMarkers: ["schema.prisma"],
        npm: { "@prisma/language-server": "^6.0.0" },
        npmBin: join("node_modules", ".bin", "prisma-language-server"),
    },
    {
        key: "latex",
        extensions: [".tex", ".bib"],
        languageId: "latex",
        runtime: "native",
        binNames: ["texlab"],
        rootMarkers: [".latexmkrc", "latexmkrc", ".texlabroot"],
        download: {
            source: { kind: "github", repo: "latex-lsp/texlab" },
            asset: "texlab-{target}.{ext}",
            targets: { darwin: "{arch}-macos", linux: "{arch}-linux", win32: "{arch}-windows" },
            archs: { x64: "x86_64", arm64: "aarch64" },
            format: "tar.gz",
            bin: "texlab{exe}",
        },
    },
    {
        key: "typst",
        extensions: [".typ", ".typc"],
        languageId: "typst",
        runtime: "native",
        binNames: ["tinymist"],
        rootMarkers: ["typst.toml"],
        // Named by Rust target triple rather than a platform/arch pair, and the
        // same release carries typlite/tinymist-viewer/tinymist-docs-tool builds
        // of every triple — hence exact asset matching, not a substring search.
        download: {
            source: { kind: "github", repo: "Myriad-Dreamin/tinymist" },
            asset: "tinymist-{target}.{ext}",
            targets: {
                darwin: "{arch}-apple-darwin",
                linux: "{arch}-unknown-linux-gnu",
                win32: "{arch}-pc-windows-msvc",
            },
            archs: { x64: "x86_64", arm64: "aarch64" },
            format: "tar.gz",
            bin: "tinymist{exe}",
        },
    },
];

const MANIFEST_PATH = join(getConfigDir(), "servers", "servers.json");

let cache: LanguageServerDef[] | null = null;

export function getServerDefs(): LanguageServerDef[] {
    if (cache) return cache;
    const byKey = new Map<string, LanguageServerDef>();
    for (const def of BUILTINS) byKey.set(def.key, def);
    for (const def of loadManifest()) byKey.set(def.key, def);
    cache = [...byKey.values()];
    return cache;
}

export function findDef(key: LanguageKey): LanguageServerDef | undefined {
    return getServerDefs().find((d) => d.key === key);
}

/** Does this server handle this file, by extension or exact filename? */
export function defHandles(def: LanguageServerDef, absPath: string): boolean {
    const ext = extname(absPath).toLowerCase();
    if (ext && def.extensions.includes(ext)) return true;
    const name = basename(absPath).toLowerCase();
    return (def.filenames ?? []).some((f) => f.toLowerCase() === name);
}

/**
 * Every server that handles this file. More than one is normal and wanted — a
 * `.ts` file is served by both the type checker and any linter configured for
 * the project, and their diagnostics are complementary.
 */
export function languageKeysFor(absPath: string): LanguageKey[] {
    return getServerDefs()
        .filter((def) => defHandles(def, absPath))
        .map((def) => def.key);
}

/** The first server handling this file, or null. */
export function languageKeyFor(absPath: string): LanguageKey | null {
    return languageKeysFor(absPath)[0] ?? null;
}

export function languageIdFor(def: LanguageServerDef, absPath: string): string {
    return typeof def.languageId === "function" ? def.languageId(absPath) : def.languageId;
}

/**
 * A user-supplied `download` block. Only the shape is checked — a bad template
 * fails later by finding no asset, which is the same outcome as a server that
 * simply isn't published for this machine, and is reported the same way.
 */
function parseDownload(value: unknown): DownloadSpec | undefined {
    if (!value || typeof value !== "object") return undefined;
    const v = value as Partial<DownloadSpec> & { source?: { kind?: string } };
    const kind = v.source?.kind;
    if (kind !== "github" && kind !== "hashicorp" && kind !== "static") return undefined;
    if (typeof v.bin !== "string" && (!v.bin || typeof v.bin !== "object")) return undefined;
    return v as DownloadSpec;
}

function loadManifest(): LanguageServerDef[] {
    if (!existsSync(MANIFEST_PATH)) return [];
    try {
        const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Record<string, unknown>;
        const defs: LanguageServerDef[] = [];
        for (const [key, value] of Object.entries(raw)) {
            const v = value as Partial<LanguageServerDef> & { extensions?: unknown };
            if (!Array.isArray(v.extensions) || typeof v.languageId !== "string" || !Array.isArray(v.binNames)) {
                continue;
            }
            defs.push({
                key,
                extensions: v.extensions.map((e) => String(e).toLowerCase()),
                filenames: Array.isArray(v.filenames) ? v.filenames.map(String) : undefined,
                languageId: v.languageId,
                runtime: v.runtime === "node" || v.runtime === "java" ? v.runtime : "native",
                binNames: v.binNames.map(String),
                args: Array.isArray(v.args) ? v.args.map(String) : [],
                jvmArgs: Array.isArray(v.jvmArgs) ? v.jvmArgs.map(String) : undefined,
                rootMarkers: Array.isArray(v.rootMarkers) ? v.rootMarkers.map(String) : undefined,
                disqualifyMarkers: Array.isArray(v.disqualifyMarkers) ? v.disqualifyMarkers.map(String) : undefined,
                requires: Array.isArray(v.requires) ? v.requires.map(String) : undefined,
                requiresMinVersion:
                    v.requiresMinVersion && typeof v.requiresMinVersion === "object"
                        ? (v.requiresMinVersion as Record<string, number>)
                        : undefined,
                npm: v.npm && typeof v.npm === "object" ? (v.npm as Record<string, string>) : undefined,
                npmBin: typeof v.npmBin === "string" ? v.npmBin : undefined,
                npmNativeBin: typeof v.npmNativeBin === "string" ? v.npmNativeBin : undefined,
                goInstall: typeof v.goInstall === "string" ? v.goInstall : undefined,
                download: parseDownload(v.download),
            });
        }
        return defs;
    } catch {
        return [];
    }
}
