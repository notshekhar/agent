/**
 * Turns a registry entry into a runnable LspServerSpec: detect a
 * project-local/PATH server first (uses the project's own toolchain), else
 * provision one into ~/.loop/servers. Everything is driven by the registry.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { LspServerSpec } from "./client";
import { ensureGoInstalled, ensureProvisioned } from "./provision";
import {
    defHandles,
    findDef,
    getServerDefs,
    type LanguageKey,
    type LanguageServerDef,
    languageIdFor,
} from "./registry";

export { defHandles, type LanguageKey, languageKeyFor, languageKeysFor, getServerDefs, findDef } from "./registry";

function onPath(name: string): string | null {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "pipe" });
    return probe.status === 0 ? name : null;
}

/** `<bin> --version` → major version number, or null if it can't be read. */
const versionCache = new Map<string, number | null>();
function majorVersion(bin: string): number | null {
    const cached = versionCache.get(bin);
    if (cached !== undefined) return cached;
    let major: number | null = null;
    try {
        const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
        const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
        // "Version 5.9.3", "tsc 7.0.2", "gopls v0.16.1" — first number wins.
        const m = /(\d+)\.\d+/.exec(text);
        if (m) major = Number(m[1]);
    } catch {
        major = null;
    }
    versionCache.set(bin, major);
    return major;
}

/**
 * A candidate is only usable if it's new enough to speak LSP. An unreadable
 * version is treated as unusable when a minimum is declared: launching a binary
 * that doesn't understand `--lsp` costs a failed handshake and takes the whole
 * language down with it, which is worse than falling through to provisioning.
 */
function usable(bin: string, def: LanguageServerDef): boolean {
    if (def.minMajorVersion === undefined) return true;
    const major = majorVersion(bin);
    return major !== null && major >= def.minMajorVersion;
}

function resolveBinary(rootPath: string, def: LanguageServerDef): string | null {
    const isWin = process.platform === "win32";
    for (const name of def.binNames) {
        const local = join(rootPath, "node_modules", ".bin", isWin ? `${name}.cmd` : name);
        if (existsSync(local) && usable(local, def)) return local;
    }
    for (const name of def.binNames) {
        if (onPath(name) && usable(name, def)) return name;
    }
    return null;
}

/** Every requirement satisfied? A server whose toolchain is missing can't run. */
function requirementsMet(def: LanguageServerDef): boolean {
    return (def.requires ?? []).every((bin) => onPath(bin) !== null);
}

/**
 * The directory a server should treat as its project root: the nearest ancestor
 * of the file holding one of the server's root markers, else the workspace. A
 * monorepo with three tsconfigs gets three servers, each scoped to its package,
 * which is what makes the diagnostics right.
 */
export function findRoot(def: LanguageServerDef, filePath: string, fallback: string): string {
    const markers = def.rootMarkers ?? [];
    if (markers.length === 0) return fallback;
    const stopAt = parse(filePath).root;
    let dir = dirname(filePath);
    for (;;) {
        for (const marker of markers) {
            if (existsSync(join(dir, marker))) return dir;
        }
        if (dir === stopAt || dir === fallback) break;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return fallback;
}

/**
 * A marker that stands this server down — a Deno project must not also be
 * served by the TypeScript server, which would double every diagnostic.
 */
export function isDisqualified(def: LanguageServerDef, filePath: string, fallback: string): boolean {
    const markers = def.disqualifyMarkers ?? [];
    if (markers.length === 0) return false;
    const root = findRoot(def, filePath, fallback);
    return markers.some((m) => existsSync(join(root, m)));
}

/**
 * Build a launch spec. "node" servers (e.g. pyright-langserver) run with loop's
 * runtime: process.execPath is the loop binary, and BUN_BE_BUN=1 makes it
 * behave as the bun CLI — so no separate node/bun is needed. "native" servers
 * (e.g. gopls, TypeScript 7's tsc) run directly.
 */
function specFromExe(def: LanguageServerDef, exe: string, forceNative = false): LspServerSpec {
    const languageId = (absPath: string) => languageIdFor(def, absPath);
    const args = def.args ?? [];
    if (def.runtime === "node" && !forceNative) {
        return { name: def.key, command: process.execPath, args: [exe, ...args], env: { BUN_BE_BUN: "1" }, languageId };
    }
    return { name: def.key, command: exe, args: [...args], languageId };
}

/** `{platform}`/`{arch}` → this machine, for npmNativeBin. */
function expandNativePath(template: string): string {
    return template.replace("{platform}", process.platform).replace("{arch}", process.arch);
}

export function resolveServer(key: LanguageKey, rootPath: string): LspServerSpec | null {
    const def = findDef(key);
    if (!def || !requirementsMet(def)) return null;
    const exe = resolveBinary(rootPath, def);
    return exe ? specFromExe(def, exe) : null;
}

export async function resolveOrProvisionServer(key: LanguageKey, rootPath: string): Promise<LspServerSpec | null> {
    const def = findDef(key);
    if (!def || !requirementsMet(def)) return null;

    const local = resolveServer(key, rootPath);
    if (local) return local;

    // npm-provisioned: prefer the native per-platform binary when the package
    // ships one (TypeScript 7), since the JS bin is only a shim over it.
    if (def.npm && def.npmBin) {
        const installed = await ensureProvisioned(key, def.npm, def.npmBin);
        if (installed) {
            if (def.npmNativeBin) {
                const native = join(installed.dir, expandNativePath(def.npmNativeBin));
                if (existsSync(native)) return specFromExe(def, native, true);
            }
            return specFromExe(def, installed.bin);
        }
    }

    if (def.goInstall) {
        const installed = await ensureGoInstalled(def.binNames[0], def.goInstall);
        if (installed) return specFromExe(def, installed, true);
    }

    return null;
}

/** Which servers could serve this file, after disqualification. */
export function serversFor(filePath: string, fallbackRoot: string): LanguageServerDef[] {
    return getServerDefs().filter(
        (def) => defHandles(def, filePath) && !isDisqualified(def, filePath, fallbackRoot) && requirementsMet(def),
    );
}
