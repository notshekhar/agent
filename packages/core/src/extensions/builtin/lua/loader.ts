/**
 * Finding and running the user's Lua.
 *
 * The whole point of the Lua surface is that there is no install step: drop a
 * file in `~/.loop/lua/` and it runs at startup. That means load order and
 * failure handling matter more than usual — a script with a syntax error must
 * not take the session down, and the user has to be told which file broke.
 *
 * Load order: `init.lua` first (so it can set options the others read), then
 * every other `*.lua` in the directory, alphabetically. Subdirectories are for
 * `require`, not for auto-loading — a module under `lua/foo/bar.lua` runs only
 * when something requires it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { LuaEngine } from "wasmoon";
import { getConfigDir } from "../../../brand";

export interface LoadedScript {
    name: string;
    path: string;
}

export interface LoadReport {
    dir: string;
    loaded: LoadedScript[];
    failures: { path: string; error: string }[];
}

/** `~/.loop/lua` — created on demand so `/lua` can point somewhere real. */
export function luaDir(): string {
    return join(getConfigDir(), "lua");
}

export function ensureLuaDir(): string {
    const dir = luaDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

/** Auto-loaded entry scripts, `init.lua` first, then the rest alphabetically. */
function entryScripts(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
        .filter((f) => f.endsWith(".lua"))
        .filter((f) => {
            try {
                return statSync(join(dir, f)).isFile();
            } catch {
                return false;
            }
        })
        .sort();
    const init = files.filter((f) => f === "init.lua");
    return [...init, ...files.filter((f) => f !== "init.lua")].map((f) => join(dir, f));
}

/**
 * Install `require`, resolving `foo.bar` to `<dir>/foo/bar.lua`.
 *
 * Lua's own `package` library is not loaded (it reaches the filesystem and the
 * C loader), so this is the only module path scripts have. Resolution is
 * confined to the Lua directory: a `..` in a module name that would escape it
 * is refused rather than quietly reaching into the rest of the disk.
 */
export function installRequire(lua: LuaEngine, dir: string): void {
    const cache = new Map<string, unknown>();
    const root = resolve(dir);

    lua.global.set("__loop_host_require", (name: unknown) => {
        const modName = typeof name === "string" ? name : "";
        if (!modName) throw new Error("require expects a module name");
        if (cache.has(modName)) return cache.get(modName);

        const rel = modName.replace(/\./g, sep);
        const candidates = [join(root, `${rel}.lua`), join(root, rel, "init.lua")];
        const path = candidates.find((p) => resolve(p).startsWith(root + sep) && existsSync(p));
        if (!path) throw new Error(`module '${modName}' not found in ${root}`);

        // Cache before running so a cycle resolves to a partial module rather
        // than recursing until the VM runs out of memory.
        cache.set(modName, true);
        const source = readFileSync(path, "utf8");
        const value = lua.doStringSync(source);
        cache.set(modName, value);
        return value;
    });

    lua.doStringSync(`function require(name) return __loop_host_require(name) end`);
}

/** Run every auto-loaded script, collecting failures instead of throwing. */
export function loadScripts(lua: LuaEngine, dir: string): LoadReport {
    const report: LoadReport = { dir, loaded: [], failures: [] };
    for (const path of entryScripts(dir)) {
        try {
            lua.doStringSync(readFileSync(path, "utf8"));
            report.loaded.push({ name: path.slice(dir.length + 1), path });
        } catch (err) {
            report.failures.push({ path, error: cleanLuaError(err) });
        }
    }
    return report;
}

/**
 * Lua errors arrive wrapped with the whole chunk inlined:
 * `[string "local x = ..."]:3: attempt to ...`. The chunk text is the script
 * the user is already looking at, so keep the line number and the message.
 */
export function cleanLuaError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw
        .replace(/\[string "[\s\S]*?"\]:/g, "line ")
        .split("\n")[0]
        .trim();
}
