/**
 * The set of language servers this extension knows about. Built-ins live here in
 * code; users add or override entries in ~/.loop/servers/servers.json — no
 * recompile needed. Each entry says how to FIND the server (binNames, looked up
 * in the project's node_modules/.bin then PATH), how to ROOT it (rootMarkers,
 * nearest ancestor wins), and optionally how to INSTALL it when absent (npm deps
 * provisioned into ~/.loop/servers/<key>/, or `go install`).
 *
 * Servers with no install route resolve from PATH only: that is deliberate for
 * anything that belongs to a toolchain the user already manages (rust-analyzer,
 * clangd, gopls, dart, julia). Downloading a compiler's language server behind
 * the user's back is worse than saying it isn't there.
 */
import { getConfigDir } from "../../../brand";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export type LanguageKey = string;

export interface LanguageServerDef {
    key: LanguageKey;
    /** File extensions this server handles, lowercase, with the dot. */
    extensions: string[];
    /** Exact filenames it also handles (e.g. "Dockerfile"), compared case-insensitively. */
    filenames?: string[];
    /** LSP languageId, or a function of the path when one server spans several. */
    languageId: string | ((absPath: string) => string);
    /** "node" runs the binary under loop's own runtime; "native" runs it directly. */
    runtime?: "node" | "native";
    binNames: string[];
    args?: string[];
    /** Files marking the project root; nearest ancestor of the edited file wins. */
    rootMarkers?: string[];
    /** Root markers that DISQUALIFY this server (a deno.json stands typescript down). */
    disqualifyMarkers?: string[];
    /** Binaries that must be on PATH for this server to work at all. */
    requires?: string[];
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
    },
    {
        key: "zig",
        extensions: [".zig", ".zon"],
        languageId: "zig",
        runtime: "native",
        binNames: ["zls"],
        rootMarkers: ["build.zig"],
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
        runtime: "native",
        binNames: ["jdtls"],
        rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", ".project"],
    },
    {
        key: "kotlin",
        extensions: [".kt", ".kts"],
        languageId: "kotlin",
        runtime: "native",
        binNames: ["kotlin-ls", "kotlin-language-server"],
        args: ["--stdio"],
        rootMarkers: ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "pom.xml"],
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
    },
    {
        key: "typst",
        extensions: [".typ", ".typc"],
        languageId: "typst",
        runtime: "native",
        binNames: ["tinymist"],
        rootMarkers: ["typst.toml"],
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

export function reloadServerDefs(): void {
    cache = null;
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
                runtime: v.runtime === "node" ? "node" : "native",
                binNames: v.binNames.map(String),
                args: Array.isArray(v.args) ? v.args.map(String) : [],
                rootMarkers: Array.isArray(v.rootMarkers) ? v.rootMarkers.map(String) : undefined,
                disqualifyMarkers: Array.isArray(v.disqualifyMarkers) ? v.disqualifyMarkers.map(String) : undefined,
                requires: Array.isArray(v.requires) ? v.requires.map(String) : undefined,
                npm: v.npm && typeof v.npm === "object" ? (v.npm as Record<string, string>) : undefined,
                npmBin: typeof v.npmBin === "string" ? v.npmBin : undefined,
                npmNativeBin: typeof v.npmNativeBin === "string" ? v.npmNativeBin : undefined,
                goInstall: typeof v.goInstall === "string" ? v.goInstall : undefined,
            });
        }
        return defs;
    } catch {
        return [];
    }
}
