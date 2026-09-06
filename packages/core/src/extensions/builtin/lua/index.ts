/**
 * Lua scripting for loop.
 *
 * Drop a `.lua` file into `~/.loop/lua/` and it runs at startup — no package,
 * no install, no build step, the way a Neovim or wezterm config works. Scripts
 * talk to a `loop` table (see prelude.ts) and can add status-line segments,
 * slash commands, timers and subprocesses today.
 *
 * The VM is real Lua 5.4 (wasmoon) with `io`, `os`, `package` and `debug`
 * removed, a 32 MB memory ceiling and a 250 ms per-call timeout, so a broken
 * script raises instead of taking the session with it. Those fences are not a
 * security boundary: a script that can run `git` can run anything, which is why
 * only the user's own `~/.loop/lua` is auto-loaded and nothing project-local is.
 */
import type { LuaEngine } from "wasmoon";
import type { ExtensionAPI } from "../../api";
import { createLuaVm } from "./vm";
import { LUA_PRELUDE } from "./prelude";
import { createOwnership, installHostFunctions, makeInvoke, type LuaRuntimeOwnership } from "./surface";
import { cleanLuaError, ensureLuaDir, installRequire, loadScripts, luaDir, type LoadReport } from "./loader";

interface Runtime {
    lua: LuaEngine;
    own: LuaRuntimeOwnership;
    report: LoadReport;
}

let runtime: Runtime | undefined;

function disposeRuntime(): void {
    if (!runtime) return;
    runtime.own.dispose();
    try {
        runtime.lua.global.close();
    } catch {
        // A VM that already died on its own is still disposed.
    }
    runtime = undefined;
}

async function startRuntime(api: ExtensionAPI): Promise<Runtime> {
    const dir = ensureLuaDir();
    const lua = await createLuaVm();
    const own = createOwnership();

    const log = (message: string): void => api.extension.log(message);

    /**
     * A widget's render runs on every frame, so a script that throws in it
     * would otherwise post an identical error line dozens of times a second and
     * bury the conversation. Repeats of the message just reported are dropped;
     * a different error still gets through immediately.
     */
    let lastError = "";
    const onError = (where: string, err: unknown): void => {
        const message = `${where}: ${cleanLuaError(err)}`;
        if (message === lastError) return;
        lastError = message;
        api.extension.log(message);
    };

    const invoke = makeInvoke(lua, (err) => onError("lua callback", err));
    installHostFunctions({ api, lua, invoke, own, log, onError });
    installRequire(lua, dir);
    lua.doStringSync(LUA_PRELUDE);

    const report = loadScripts(lua, dir);
    for (const failure of report.failures) {
        api.extension.log(`${failure.path}: ${failure.error}`);
    }
    return { lua, own, report };
}

function statusText(): string | undefined {
    if (!runtime) return "not loaded";
    const { loaded, failures } = runtime.report;
    if (loaded.length === 0 && failures.length === 0) return "no scripts";
    const parts = [`${loaded.length} script${loaded.length === 1 ? "" : "s"}`];
    if (failures.length > 0) parts.push(`${failures.length} failed`);
    return parts.join(", ");
}

export default {
    async activate(api: ExtensionAPI) {
        api.extension.setStatus(statusText);

        try {
            runtime = await startRuntime(api);
        } catch (err) {
            api.extension.log(`failed to start the Lua runtime: ${cleanLuaError(err)}`);
        }

        api.commands.register({
            name: "lua",
            description: "Lua scripts: status, and `reload` to re-run them",
            handler: async (ctx, args) => {
                const arg = (args ?? "").trim();
                if (arg === "reload") {
                    disposeRuntime();
                    try {
                        runtime = await startRuntime(api);
                    } catch (err) {
                        ctx.emit("error", `lua reload failed: ${cleanLuaError(err)}`);
                        return;
                    }
                    const { loaded, failures } = runtime.report;
                    ctx.emit(
                        failures.length > 0 ? "error" : "help",
                        `Reloaded ${loaded.length} script(s) from ${luaDir()}` +
                            (failures.length > 0
                                ? `\n${failures.map((f) => `  ${f.path}: ${f.error}`).join("\n")}`
                                : ""),
                    );
                    return;
                }

                const lines = [`Lua scripts live in ${luaDir()}`];
                if (!runtime) {
                    lines.push("", "The runtime is not loaded.");
                } else {
                    const { loaded, failures } = runtime.report;
                    lines.push(
                        "",
                        loaded.length > 0
                            ? `Loaded:\n${loaded.map((s) => `  ${s.name}`).join("\n")}`
                            : "No scripts yet — create init.lua in that directory.",
                    );
                    if (failures.length > 0) {
                        lines.push("", `Failed:\n${failures.map((f) => `  ${f.path}: ${f.error}`).join("\n")}`);
                    }
                }
                lines.push("", "`/lua reload` re-runs them.");
                ctx.emit("help", lines.join("\n"));
            },
        });
    },

    deactivate() {
        disposeRuntime();
    },
};
