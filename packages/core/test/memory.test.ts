import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadMemoryContext, memoryDir } from "../src/agent/memory";

const dirs: string[] = [];
function mkTmp(prefix: string): string {
    // realpath: macOS tmpdir is a /var → /private/var symlink; findRepoRoot
    // walks real paths, so the test must too.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("memoryDir", () => {
    test("keys by repo root, not cwd, using the sessions slug convention", () => {
        const base = mkTmp("loop-mem-base-");
        const repo = mkTmp("loop-mem-repo-");
        mkdirSync(join(repo, ".git"));
        const nested = join(repo, "packages", "core");
        mkdirSync(nested, { recursive: true });

        const slug = `--${repo.replace(/^\/+|\/+$/g, "").replace(/\//g, "-")}--`;
        const expected = join(base, "agent", "memory", slug);
        expect(memoryDir(repo, base)).toBe(expected);
        // any subdir of the repo shares the same memory
        expect(memoryDir(nested, base)).toBe(expected);
    });

    test("falls back to the cwd itself outside a git repo", () => {
        const base = mkTmp("loop-mem-base-");
        const plain = mkTmp("loop-mem-plain-");
        expect(memoryDir(plain, base)).toContain(plain.replace(/\//g, "-"));
    });
});

describe("loadMemoryContext", () => {
    test("no index yet: injects the policy with an empty-index marker", () => {
        const base = mkTmp("loop-mem-base-");
        const repo = mkTmp("loop-mem-repo-");
        const ctx = loadMemoryContext(repo, base);
        expect(ctx.dir).toBe(memoryDir(repo, base));
        expect(ctx.indexPath).toBe(join(ctx.dir, "MEMORY.md"));
        expect(ctx.text).toStartWith("<memory>");
        expect(ctx.text).toEndWith("</memory>");
        expect(ctx.text).toContain(ctx.dir); // policy names the real dir
        expect(ctx.text).toContain("(empty — no memories saved yet)");
    });

    test("existing index is injected verbatim", () => {
        const base = mkTmp("loop-mem-base-");
        const repo = mkTmp("loop-mem-repo-");
        const dir = memoryDir(repo, base);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "MEMORY.md"), "- [Build gotcha](build-gotcha.md) — bun only\n");
        const ctx = loadMemoryContext(repo, base);
        expect(ctx.text).toContain("- [Build gotcha](build-gotcha.md) — bun only");
        expect(ctx.text).not.toContain("(empty — no memories saved yet)");
    });

    test("oversized index is truncated with a pruning hint", () => {
        const base = mkTmp("loop-mem-base-");
        const repo = mkTmp("loop-mem-repo-");
        const dir = memoryDir(repo, base);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "MEMORY.md"), "- line\n".repeat(3000)); // ~21KB
        const ctx = loadMemoryContext(repo, base);
        expect(ctx.text).toContain("[index truncated");
        expect(ctx.text.length).toBeLessThan(12 * 1024);
    });

    test("whitespace-only index reads as empty", () => {
        const base = mkTmp("loop-mem-base-");
        const repo = mkTmp("loop-mem-repo-");
        const dir = memoryDir(repo, base);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "MEMORY.md"), "  \n\n");
        expect(loadMemoryContext(repo, base).text).toContain("(empty — no memories saved yet)");
    });
});
