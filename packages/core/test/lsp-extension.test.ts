import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { javaConfigDir, locateBinary, resolveTarget } from "../src/extensions/builtin/lsp/download";
import { reportDiagnostics, resolveColumn } from "../src/extensions/builtin/lsp/index";
import { sampleFiles } from "../src/extensions/builtin/lsp/manager";
import { LSP_OPERATIONS, needsPosition } from "../src/extensions/builtin/lsp/operations";
import { defHandles, getServerDefs, languageKeysFor } from "../src/extensions/builtin/lsp/registry";
import {
    downloadsDisabled,
    findRoot,
    isDisqualified,
    resolveOrProvisionServer,
    resolveServer,
    specFromJar,
} from "../src/extensions/builtin/lsp/servers";
import { hoverText, SYMBOL_KIND } from "../src/extensions/builtin/lsp/protocol";
import type { Diagnostic } from "../src/extensions/builtin/lsp/protocol";

const def = (key: string) => getServerDefs().find((d) => d.key === key)!;

describe("language coverage", () => {
    test("every builtin server declares what it handles and how to launch it", () => {
        for (const d of getServerDefs()) {
            expect(d.binNames.length, `${d.key} has no binNames`).toBeGreaterThan(0);
            expect(typeof d.languageId === "string" || typeof d.languageId === "function").toBe(true);
            // A server with no extensions must be reachable some other way.
            if (d.extensions.length === 0) expect(d.filenames ?? d.rootMarkers).toBeDefined();
        }
    });

    test("covers the languages opencode's server set covers", () => {
        // One representative file per language family.
        const samples: Record<string, string> = {
            "a.ts": "typescript",
            "a.tsx": "typescript",
            "a.js": "typescript",
            "a.vue": "vue",
            "a.svelte": "svelte",
            "a.astro": "astro",
            "a.go": "go",
            "a.rs": "rust",
            "a.c": "clangd",
            "a.cpp": "clangd",
            "a.zig": "zig",
            "a.swift": "swift",
            "a.nix": "nix",
            "a.java": "java",
            "a.kt": "kotlin",
            "a.cs": "csharp",
            "a.razor": "razor",
            "a.fs": "fsharp",
            "a.py": "python",
            "a.rb": "ruby",
            "a.php": "php",
            "a.lua": "lua",
            "a.sh": "bash",
            "a.ex": "elixir",
            "a.dart": "dart",
            "a.jl": "julia",
            "a.hs": "haskell",
            "a.ml": "ocaml",
            "a.clj": "clojure",
            "a.gleam": "gleam",
            "a.yaml": "yaml",
            "a.json": "json",
            "a.tf": "terraform",
            "a.prisma": "prisma",
            "a.tex": "latex",
            "a.typ": "typst",
        };
        for (const [file, expected] of Object.entries(samples)) {
            expect(languageKeysFor(`/proj/${file}`), `${file} should reach ${expected}`).toContain(expected);
        }
    });

    test("Dockerfile is matched by name, not extension", () => {
        expect(languageKeysFor("/proj/Dockerfile")).toContain("dockerfile");
        expect(languageKeysFor("/proj/dockerfile")).toContain("dockerfile");
        expect(defHandles(def("dockerfile"), "/proj/Containerfile")).toBe(true);
    });

    test("typescript uses TypeScript 7's own native LSP, not a wrapper", () => {
        const ts = def("typescript");
        expect(ts.npm).toEqual({ typescript: "^7.0.0" });
        expect(ts.args).toEqual(["--lsp", "--stdio"]);
        expect(ts.runtime).toBe("native");
        // The npm bin is a JS shim; the native per-platform binary is preferred.
        expect(ts.npmNativeBin).toContain("{platform}");
        expect(ts.npmNativeBin).toContain("{arch}");
    });

    test("a file can be served by more than one server", () => {
        // .json is both a biome and a json-language-server target.
        expect(languageKeysFor("/proj/a.json").length).toBeGreaterThan(1);
    });
});

describe("project root detection", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-lsp-"));
    mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "app", "tsconfig.json"), "{}");
    const file = join(root, "packages", "app", "src", "main.ts");
    writeFileSync(file, "export {};");

    test("the nearest ancestor holding a root marker wins", () => {
        // A monorepo package gets its own server, scoped to its tsconfig.
        expect(findRoot(def("typescript"), file, root)).toBe(join(root, "packages", "app"));
    });

    test("falls back to the workspace when no marker is found", () => {
        const bare = mkdtempSync(join(tmpdir(), "loop-lsp-bare-"));
        const f = join(bare, "x.ts");
        writeFileSync(f, "export {};");
        expect(findRoot(def("typescript"), f, bare)).toBe(bare);
    });

    test("a deno project stands the typescript server down", () => {
        const deno = mkdtempSync(join(tmpdir(), "loop-lsp-deno-"));
        writeFileSync(join(deno, "deno.json"), "{}");
        const f = join(deno, "mod.ts");
        writeFileSync(f, "export {};");
        expect(isDisqualified(def("typescript"), f, deno)).toBe(true);
        expect(isDisqualified(def("deno"), f, deno)).toBe(false);
    });
});

describe("a discovered binary must be new enough to speak LSP", () => {
    /** A fake `tsc` in <dir>/node_modules/.bin that reports `version`. */
    function fakeTsc(version: string): string {
        const dir = mkdtempSync(join(tmpdir(), "loop-lsp-bin-"));
        const bin = join(dir, "node_modules", ".bin");
        mkdirSync(bin, { recursive: true });
        const path = join(bin, "tsc");
        writeFileSync(path, `#!/bin/sh\necho "Version ${version}"\n`);
        chmodSync(path, 0o755);
        return dir;
    }

    test("a project's TypeScript 5 is skipped, not launched", () => {
        // `tsc` has been in node_modules for a decade but only v7 answers
        // --lsp. Launching v5 fails the handshake and kills the language.
        // Falling through to a usable `tsc` elsewhere is fine and expected —
        // what must never happen is picking the v5 one. (Asserting null here
        // would only hold on machines with no TypeScript on PATH.)
        const dir = fakeTsc("5.9.3");
        const spec = resolveServer("typescript", dir);
        expect(spec?.command).not.toBe(join(dir, "node_modules", ".bin", "tsc"));
    });

    test("a project's TypeScript 7 is used as-is", () => {
        const dir = fakeTsc("7.0.2");
        const spec = resolveServer("typescript", dir);
        expect(spec).not.toBeNull();
        expect(spec?.command).toBe(join(dir, "node_modules", ".bin", "tsc"));
        expect(spec?.args).toEqual(["--lsp", "--stdio"]);
    });

    test("servers with no declared minimum are unaffected", () => {
        // Only typescript declares one; nothing else should gain a version probe.
        const withMin = getServerDefs()
            .filter((d) => d.minMajorVersion !== undefined)
            .map((d) => d.key);
        expect(withMin).toEqual(["typescript"]);
    });
});

describe("a directory is a valid target for workspaceSymbol", () => {
    // workspaceSymbol is asked about a project, so a directory (or the repo
    // root) is the natural thing to name — matching servers by file extension
    // finds nothing for one, which read as "no language server available".
    const root = mkdtempSync(join(tmpdir(), "loop-lsp-dir-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
    writeFileSync(join(root, "src", "main.ts"), "export const x = 1;");
    writeFileSync(join(root, "README.md"), "# hi");
    writeFileSync(join(root, "node_modules", "junk", "index.ts"), "export {};");

    test("finds the languages a project is written in", () => {
        const picked = sampleFiles(root);
        expect(picked.some((f) => f.endsWith(join("src", "main.ts")))).toBe(true);
    });

    test("skips node_modules — a dependency's language is not the project's", () => {
        expect(sampleFiles(root).some((f) => f.includes("node_modules"))).toBe(false);
    });

    test("returns one file per language, not every file", () => {
        mkdirSync(join(root, "src", "more"), { recursive: true });
        writeFileSync(join(root, "src", "more", "a.ts"), "export {};");
        writeFileSync(join(root, "src", "more", "b.ts"), "export {};");
        const ts = sampleFiles(root).filter((f) => f.endsWith(".ts"));
        expect(ts).toHaveLength(1);
    });

    test("a directory with nothing recognizable yields nothing", () => {
        const empty = mkdtempSync(join(tmpdir(), "loop-lsp-empty-"));
        writeFileSync(join(empty, "notes.txt"), "hello");
        expect(sampleFiles(empty)).toEqual([]);
    });
});

describe("diagnostics report", () => {
    const at = (line: number, char: number, message: string, severity: 1 | 2 = 1): Diagnostic => ({
        range: { start: { line, character: char }, end: { line, character: char + 1 } },
        severity,
        message,
    });

    test("renders errors in the documented shape", () => {
        const out = reportDiagnostics("/proj", "/proj/src/a.ts", [at(3, 10, "Type 'string' is not assignable")]);
        expect(out).toBe(`<diagnostics file="src/a.ts">\nERROR [4:11] Type 'string' is not assignable\n</diagnostics>`);
    });

    test("warnings are not reported — the agent acts on everything it is shown", () => {
        expect(reportDiagnostics("/proj", "/proj/a.ts", [at(0, 0, "unused variable", 2)])).toBe("");
    });

    test("a clean file adds nothing at all", () => {
        expect(reportDiagnostics("/proj", "/proj/a.ts", [])).toBe("");
    });

    test("caps at 20 per file and says how many were dropped", () => {
        const many = Array.from({ length: 25 }, (_, i) => at(i, 0, `problem ${i}`));
        const out = reportDiagnostics("/proj", "/proj/a.ts", many);
        expect(out.split("\n").filter((l) => l.startsWith("ERROR"))).toHaveLength(20);
        expect(out).toContain("... and 5 more");
    });

    test("multi-line messages are flattened to one line each", () => {
        const out = reportDiagnostics("/proj", "/proj/a.ts", [at(0, 0, "line one\n  line two")]);
        expect(out).toContain("ERROR [1:1] line one line two");
    });
});

describe("operations", () => {
    test("exposes the nine operations", () => {
        expect(LSP_OPERATIONS).toHaveLength(9);
        expect(LSP_OPERATIONS).toContain("goToDefinition");
        expect(LSP_OPERATIONS).toContain("incomingCalls");
    });

    test("only position operations require line/character", () => {
        expect(needsPosition("goToDefinition")).toBe(true);
        expect(needsPosition("hover")).toBe(true);
        expect(needsPosition("documentSymbol")).toBe(false);
        expect(needsPosition("workspaceSymbol")).toBe(false);
    });

    test("hover text is flattened out of every shape servers use", () => {
        expect(hoverText("plain")).toBe("plain");
        expect(hoverText({ kind: "markdown", value: "# md" })).toBe("# md");
        expect(hoverText([{ language: "ts", value: "const x" }, "note"])).toBe("const x\n\nnote");
        expect(hoverText(null)).toBe("");
    });

    test("symbol kinds are named, not numbered", () => {
        expect(SYMBOL_KIND[12]).toBe("function");
        expect(SYMBOL_KIND[5]).toBe("class");
    });
});

/**
 * The model never sees columns — only line numbers, from `read` and `grep`. So
 * a position is named by its symbol and the column is found here; these are the
 * ways that lookup can go wrong.
 */
describe("resolving a position from a symbol name", () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-symbol-"));
    const file = join(dir, "sample.ts");
    writeFileSync(
        file,
        [
            "export function runTurn(x: number) {",
            "    return rerun(runTurn, x);",
            "}",
            "const y = runTurn(runTurn(1));",
            "",
        ].join("\n"),
    );

    test("finds the symbol's 1-based column on the given line", async () => {
        expect(await resolveColumn(file, 1, "runTurn")).toEqual({ character: 17 });
    });

    test("word boundaries keep a short name out of a longer one", async () => {
        // `rerun` contains "run", and sits left of the real `runTurn` on line 2.
        expect(await resolveColumn(file, 2, "runTurn")).toEqual({ character: 18 });
    });

    test("the first occurrence on the line wins", async () => {
        // Line 4 names runTurn twice; `character` is the escape hatch for the second.
        expect(await resolveColumn(file, 4, "runTurn")).toEqual({ character: 11 });
    });

    test("a symbol with non-word edges still matches", async () => {
        expect(await resolveColumn(file, 1, "(x:")).toEqual({ character: 24 });
    });

    test("a miss quotes the line back, so the next attempt can be right", async () => {
        const out = await resolveColumn(file, 3, "runTurn");
        expect(out).toHaveProperty("error");
        expect((out as { error: string }).error).toContain('"runTurn" is not on line 3');
    });

    test("a line past the end says so rather than reporting a missing symbol", async () => {
        const out = await resolveColumn(file, 99, "runTurn");
        expect((out as { error: string }).error).toContain("past the end");
    });

    test("an unreadable file is an error, not a throw", async () => {
        const out = await resolveColumn(join(dir, "nope.ts"), 1, "x");
        expect((out as { error: string }).error).toContain("cannot read");
    });
});

/**
 * The download route decides everything about WHICH archive to fetch before it
 * opens a socket, so all of this is testable offline by pretending to be another
 * machine. The asset names asserted here were checked against the live releases.
 */
describe("download targets", () => {
    /** Run `fn` as if on another platform/arch. */
    function asMachine<T>(platform: string, arch: string, fn: () => T): T {
        const real = { platform: process.platform, arch: process.arch };
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        Object.defineProperty(process, "arch", { value: arch, configurable: true });
        try {
            return fn();
        } finally {
            Object.defineProperty(process, "platform", { value: real.platform, configurable: true });
            Object.defineProperty(process, "arch", { value: real.arch, configurable: true });
        }
    }

    const spec = (key: string) => def(key).download!;
    /** The asset name a machine would ask for, or null if it declines. */
    const assetFor = (key: string, platform: string, arch: string) =>
        asMachine(platform, arch, () => {
            const t = resolveTarget(spec(key));
            if (!t) return null;
            const s = spec(key);
            return (s.asset ?? "{target}").replace(/\{(\w+)\}/g, (w, n) =>
                n === "target" ? t.target : n === "arch" ? t.arch : n === "ext" ? t.ext : n === "version" ? "1.2.3" : w,
            );
        });

    test("zls asset names match the vocabulary upstream publishes", () => {
        expect(assetFor("zig", "darwin", "arm64")).toBe("zls-aarch64-macos.tar.xz");
        expect(assetFor("zig", "linux", "x64")).toBe("zls-x86_64-linux.tar.xz");
        // Windows is always a zip, whatever `format` says.
        expect(assetFor("zig", "win32", "arm64")).toBe("zls-aarch64-windows.zip");
        expect(assetFor("zig", "linux", "ia32")).toBe("zls-x86-linux.tar.xz");
    });

    test("tinymist is named by rust target triple", () => {
        expect(assetFor("typst", "darwin", "arm64")).toBe("tinymist-aarch64-apple-darwin.tar.gz");
        expect(assetFor("typst", "linux", "x64")).toBe("tinymist-x86_64-unknown-linux-gnu.tar.gz");
        expect(assetFor("typst", "win32", "x64")).toBe("tinymist-x86_64-pc-windows-msvc.zip");
    });

    test("clangd ships one build per OS, not per arch", () => {
        expect(assetFor("clangd", "darwin", "arm64")).toBe("clangd-mac-1.2.3.zip");
        expect(assetFor("clangd", "darwin", "x64")).toBe("clangd-mac-1.2.3.zip");
        expect(assetFor("clangd", "win32", "x64")).toBe("clangd-windows-1.2.3.zip");
    });

    test("lua-language-server carries the version in the asset name", () => {
        expect(assetFor("lua", "darwin", "arm64")).toBe("lua-language-server-1.2.3-darwin-arm64.tar.gz");
        expect(assetFor("lua", "win32", "ia32")).toBe("lua-language-server-1.2.3-win32-ia32.zip");
    });

    test("a machine upstream doesn't build for declines before any network call", () => {
        // Named by the maps, but not actually published.
        expect(assetFor("zig", "darwin", "ia32")).toBeNull();
        expect(assetFor("lua", "linux", "ia32")).toBeNull();
        // Not in the arch map at all — texlab publishes no 32-bit unix build.
        expect(assetFor("latex", "linux", "ia32")).toBeNull();
        // Not a platform anyone here builds for.
        expect(assetFor("typst", "freebsd", "x64")).toBeNull();
    });

    test("jdtls is arch- and OS-independent, so every machine resolves", () => {
        for (const [platform, arch] of [
            ["darwin", "arm64"],
            ["linux", "x64"],
            ["win32", "x64"],
        ]) {
            expect(asMachine(platform, arch, () => resolveTarget(spec("java")))).not.toBeNull();
        }
    });

    test("every download spec names a binary and covers the three platforms", () => {
        for (const d of getServerDefs()) {
            if (!d.download) continue;
            expect(d.download.bin, `${d.key} declares no bin`).toBeTruthy();
            if (!d.download.targets) continue;
            for (const platform of ["darwin", "linux", "win32"]) {
                expect(d.download.targets[platform], `${d.key} has no ${platform} target`).toBeTruthy();
            }
        }
    });
});

describe("installation can be switched off entirely", () => {
    test("LOOP_DISABLE_LSP_DOWNLOAD stops provisioning but not discovery", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-nodl-"));
        const previous = process.env.LOOP_DISABLE_LSP_DOWNLOAD;
        process.env.LOOP_DISABLE_LSP_DOWNLOAD = "1";
        try {
            // texlab is download-only, so with the switch on there is nothing to
            // fall back to — and crucially this returns without touching the
            // network, which is what makes it usable on an airgapped machine.
            expect(await resolveOrProvisionServer("latex", dir)).toBeNull();
        } finally {
            if (previous === undefined) delete process.env.LOOP_DISABLE_LSP_DOWNLOAD;
            else process.env.LOOP_DISABLE_LSP_DOWNLOAD = previous;
        }
    });

    test("only a meaningfully-set value counts as off", () => {
        const previous = process.env.LOOP_DISABLE_LSP_DOWNLOAD;
        const withValue = (value: string | undefined) => {
            if (value === undefined) delete process.env.LOOP_DISABLE_LSP_DOWNLOAD;
            else process.env.LOOP_DISABLE_LSP_DOWNLOAD = value;
            return downloadsDisabled();
        };
        try {
            expect(withValue("1")).toBe(true);
            expect(withValue("true")).toBe(true);
            // A variable exported as empty, or explicitly switched off, must not
            // silently disable installs — that failure mode is invisible.
            expect(withValue(undefined)).toBe(false);
            expect(withValue("")).toBe(false);
            expect(withValue("0")).toBe(false);
            expect(withValue("false")).toBe(false);
        } finally {
            if (previous === undefined) delete process.env.LOOP_DISABLE_LSP_DOWNLOAD;
            else process.env.LOOP_DISABLE_LSP_DOWNLOAD = previous;
        }
    });
});

describe("locating the binary inside an unpacked archive", () => {
    const unpack = (layout: Record<string, string>) => {
        const dir = mkdtempSync(join(tmpdir(), "loop-dl-"));
        for (const [rel, body] of Object.entries(layout)) {
            const full = join(dir, rel);
            mkdirSync(join(full, ".."), { recursive: true });
            writeFileSync(full, body);
        }
        return dir;
    };
    const spec = (bin: string) => ({ source: { kind: "static" as const }, url: "x", bin });

    test("finds the binary exactly where the registry says", () => {
        const dir = unpack({ "bin/lua-language-server": "#!" });
        expect(locateBinary(dir, spec("bin/lua-language-server{exe}"), { exe: "" })).toBe(
            join(dir, "bin/lua-language-server"),
        );
    });

    test("resolves a glob, for a jar with a build stamp in its name", () => {
        const dir = unpack({ "plugins/org.eclipse.equinox.launcher_1.7.0.v2026.jar": "x", "plugins/other.jar": "x" });
        expect(locateBinary(dir, spec("plugins/org.eclipse.equinox.launcher_*.jar"), {})).toBe(
            join(dir, "plugins/org.eclipse.equinox.launcher_1.7.0.v2026.jar"),
        );
    });

    /**
     * The case that would otherwise be a silent breakage: tinymist really does
     * wrap its contents in a target-triple directory, and projects add or drop
     * that wrapper between releases.
     */
    test("still finds a binary the archive moved into a top-level directory", () => {
        const dir = unpack({ "tinymist-aarch64-apple-darwin/tinymist": "#!" });
        expect(locateBinary(dir, spec("tinymist{exe}"), { exe: "" })).toBe(
            join(dir, "tinymist-aarch64-apple-darwin/tinymist"),
        );
    });

    test("reports nothing rather than guessing when the binary truly isn't there", () => {
        expect(locateBinary(unpack({ "README.md": "x" }), spec("texlab"), {})).toBeNull();
    });
});

describe("java servers are launched by the user's JVM", () => {
    /** A jdtls tree carrying every config directory the snapshot really ships. */
    function unpackedJdtls(names = ["config_mac", "config_mac_arm", "config_linux", "config_linux_arm", "config_win"]) {
        const dir = mkdtempSync(join(tmpdir(), "loop-jdtls-"));
        for (const name of names) mkdirSync(join(dir, name), { recursive: true });
        return dir;
    }

    /**
     * Recent snapshots ship arm-specific configurations beside the x86 ones.
     * Picking config_mac on Apple Silicon starts a JVM that fails to load the
     * native bits, so the arm variant wins wherever it exists — and where it
     * doesn't, the plain one still has to be found.
     */
    test("prefers the arm configuration on arm, and falls back when absent", () => {
        const platform = process.platform;
        const base = platform === "darwin" ? "config_mac" : platform === "win32" ? "config_win" : "config_linux";

        const full = unpackedJdtls();
        expect(javaConfigDir(full)).toBe(join(full, process.arch === "arm64" ? `${base}_arm` : base));

        // An older snapshot with no arm variants still has to resolve.
        const plain = unpackedJdtls(["config_mac", "config_linux", "config_win"]);
        expect(javaConfigDir(plain)).toBe(join(plain, base));

        // Nothing usable: report it rather than building a broken command line.
        expect(javaConfigDir(unpackedJdtls([]))).toBeNull();
    });

    test("JVM flags go before -jar, where the JVM will read them", () => {
        const dir = unpackedJdtls();
        const jar = join(dir, "launcher.jar");
        writeFileSync(jar, "");

        const spec = specFromJar(def("java"), jar, dir)!;
        expect(spec.command).toBe("java");

        const jarAt = spec.args.indexOf("-jar");
        expect(jarAt).toBeGreaterThan(0);
        expect(spec.args[jarAt + 1]).toBe(jar);
        // Every -D and --add-* is a JVM flag, so all of them precede -jar.
        for (const [i, arg] of spec.args.entries()) {
            if (arg.startsWith("-D") || arg.startsWith("--add-")) expect(i).toBeLessThan(jarAt);
        }
        // And each --add-opens is a single argv element, not a string with a
        // space in it, which the JVM would read as one oddly-named flag.
        for (const arg of spec.args) expect(arg).not.toContain(" ");
    });

    test("the templated config and data directories are resolved, not passed through", () => {
        const dir = unpackedJdtls();
        writeFileSync(join(dir, "launcher.jar"), "");

        const spec = specFromJar(def("java"), join(dir, "launcher.jar"), dir)!;
        expect(spec.args.join(" ")).not.toContain("{");
        const data = spec.args[spec.args.indexOf("-data") + 1];
        expect(existsSync(data)).toBe(true);
    });

    test("an unpacked tree with no usable config directory yields no server", () => {
        expect(specFromJar(def("java"), "/nope/launcher.jar", mkdtempSync(join(tmpdir(), "loop-empty-")))).toBeNull();
    });
});
