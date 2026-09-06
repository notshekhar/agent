/**
 * The Lua VM: creation, sandboxing, and the wasm the whole thing rides on.
 *
 * Lua is real Lua 5.4 (wasmoon), not a JS reimplementation, so scripts behave
 * the way a Neovim/wezterm user expects. It runs in-process and calls are
 * synchronous, which is what lets a Lua function serve as a status-line
 * contributor or a TUI component render.
 */
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { LuaFactory, LuaLibraries, type LuaEngine } from "wasmoon";
import { getConfigDir } from "../../../brand";
import { GLUE_WASM_GZ_B64, WASMOON_VERSION } from "./wasm-blob";

/**
 * Standard libraries a script gets. Deliberately omits `io`, `os`, `package`
 * and `debug`: file and process access reach loop through `loop.*`, where they
 * are visible and can be gated, rather than through Lua's own back doors.
 * `loop.now()` and `loop.time()` cover what `os` was actually wanted for.
 */
const SAFE_LIBRARIES = [
    LuaLibraries.Base,
    LuaLibraries.String,
    LuaLibraries.Table,
    LuaLibraries.Math,
    LuaLibraries.Coroutine,
] as const;

/**
 * Open the real `utf8` library.
 *
 * wasmoon 1.16.0 has `loadLibrary(LuaLibraries.UTF8)` call `luaopen_string`
 * and bind the result as `utf8` — so `utf8` is a second copy of `string`,
 * `utf8.len` is byte length, and `utf8.char` rejects anything over 255. It
 * fails silently in the direction that matters: any script measuring the width
 * of box-drawing or accented text gets a number three times too large and draws
 * a ragged box, with no error to explain it.
 *
 * `luaopen_utf8` is exported by the same wasm, so the fix is to call it
 * directly rather than patch the dependency.
 */
function openUtf8Library(lua: LuaEngine): void {
    const raw = lua.global.lua as unknown as {
        luaopen_utf8?(address: number): void;
        lua_setglobal(address: number, name: string): void;
    };
    if (typeof raw.luaopen_utf8 !== "function") return; // upstream fixed it; loadLibrary is enough
    raw.luaopen_utf8(lua.global.address);
    raw.lua_setglobal(lua.global.address, "utf8");
}

/** Base-library escapes that load arbitrary chunks or touch the filesystem. */
const BASE_LIB_ESCAPES = ["dofile", "loadfile", "load", "loadstring", "collectgarbage"];

/**
 * Hands `debug.getinfo` to the prelude under a private name, then removes the
 * `debug` table from scripts. The prelude needs exactly one thing from it —
 * a function's declared parameter count, to tell `function W:render(w)` from
 * `function W.render(w)` — and nothing else in `debug` is safe to expose.
 * Capturing it as an upvalue is what lets the global go away.
 */
const ARITY_PROBE = `
__loop_getinfo = debug.getinfo
debug = nil
`;

/** Memory ceiling per VM. A runaway table allocation raises "not enough memory". */
const MEMORY_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Wall-clock ceiling for one JS->Lua call, enforced by a `lua_sethook` count
 * hook, so an accidental `while true do end` in a widget's render raises
 * instead of hanging the session.
 */
const CALL_TIMEOUT_MS = 250;

/**
 * Materialize the embedded wasm next to the config, once per wasmoon version.
 *
 * wasmoon can only take a *path* (emscripten `locateFile`), never bytes, so the
 * blob has to reach the filesystem before the VM can start. Written via a
 * temp file + rename so two loop processes racing on first run can't leave a
 * half-written wasm behind.
 */
function materializeWasm(): string {
    const dir = join(getConfigDir(), "cache");
    const path = join(dir, `lua-glue-${WASMOON_VERSION}.wasm`);
    if (existsSync(path)) return path;
    mkdirSync(dir, { recursive: true });
    const bytes = Bun.gunzipSync(Buffer.from(GLUE_WASM_GZ_B64, "base64"));
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
    return path;
}

let factory: LuaFactory | undefined;

/** Create a sandboxed Lua 5.4 engine. */
export async function createLuaVm(): Promise<LuaEngine> {
    factory ??= new LuaFactory(materializeWasm());
    const lua = await factory.createEngine({
        openStandardLibs: false,
        injectObjects: false,
        traceAllocations: true, // required before setMemoryMax is allowed
        functionTimeout: CALL_TIMEOUT_MS,
    });
    for (const lib of SAFE_LIBRARIES) lua.global.loadLibrary(lib);
    openUtf8Library(lua);
    // Loaded only to capture getinfo; ARITY_PROBE removes it again immediately.
    lua.global.loadLibrary(LuaLibraries.Debug);
    lua.doStringSync(ARITY_PROBE);
    lua.global.setMemoryMax(MEMORY_MAX_BYTES);
    // Base opens these regardless of which libraries were loaded.
    lua.doStringSync(BASE_LIB_ESCAPES.map((n) => `${n} = nil`).join("\n"));
    return lua;
}

export { MEMORY_MAX_BYTES, CALL_TIMEOUT_MS };
