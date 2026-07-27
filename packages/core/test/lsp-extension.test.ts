import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportDiagnostics } from "../src/extensions/builtin/lsp/index";
import { sampleFiles } from "../src/extensions/builtin/lsp/manager";
import { LSP_OPERATIONS, needsPosition } from "../src/extensions/builtin/lsp/operations";
import { defHandles, getServerDefs, languageKeysFor } from "../src/extensions/builtin/lsp/registry";
import { findRoot, isDisqualified, resolveServer } from "../src/extensions/builtin/lsp/servers";
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
