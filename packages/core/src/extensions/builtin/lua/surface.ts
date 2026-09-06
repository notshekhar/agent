/**
 * The host half of the Lua surface: the `__loop_host_*` functions the prelude
 * calls, and the bridge that turns a Lua callback handle into something loop's
 * extension API can use.
 *
 * Everything registered here is owned by the extension, so disabling or
 * reloading the Lua extension tears it all down — timers and child processes
 * included. A script never has to clean up after itself, and a reload can't
 * leave orphaned shells behind.
 */
import { spawn, spawnSync } from "node:child_process";
import type { LuaEngine } from "wasmoon";
import type {
    DockHandle,
    TerminalHandle,
    ExtensionAPI,
    StatusLineContext,
    StatusSegment,
    WidgetHandle,
    WidgetMouseEvent,
    WidgetOptions,
} from "../../api";
import { asBoolean, asNumber, asString, toRecord, toStringArray } from "./marshal";

/** Everything one VM generation owns, so a reload can drop it all at once. */
export interface LuaRuntimeOwnership {
    timers: Set<ReturnType<typeof setTimeout>>;
    children: Set<ReturnType<typeof spawn>>;
    /** Painted widgets and live key bindings — torn down on reload/disable. */
    widgets: Set<WidgetHandle>;
    docks: Set<DockHandle>;
    keymaps: Set<() => void>;
    dispose(): void;
}

export function createOwnership(): LuaRuntimeOwnership {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const children = new Set<ReturnType<typeof spawn>>();
    const widgets = new Set<WidgetHandle>();
    const docks = new Set<DockHandle>();
    const keymaps = new Set<() => void>();
    return {
        timers,
        children,
        widgets,
        docks,
        keymaps,
        dispose() {
            for (const t of timers) clearTimeout(t);
            timers.clear();
            for (const c of children) {
                try {
                    c.kill();
                } catch {
                    // already gone
                }
            }
            children.clear();
            // Widgets are already on screen, so `/lua reload` has to take them
            // down here — dropping the reference would leave a box painted over
            // the chat that no script can reach any more.
            for (const w of widgets) {
                try {
                    w.hide();
                } catch {
                    // the TUI may already have removed it
                }
            }
            widgets.clear();
            for (const d of docks) {
                try {
                    d.close();
                } catch {
                    // already closed
                }
            }
            docks.clear();
            for (const dispose of keymaps) {
                try {
                    dispose();
                } catch {
                    // same
                }
            }
            keymaps.clear();
        },
    };
}

/** Invoke a registered Lua callback by handle. Never throws. */
export type Invoke = (handle: number, ...args: unknown[]) => unknown;

export function makeInvoke(lua: LuaEngine, onError: (err: unknown) => void): Invoke {
    // Resolved on first use, not here: the host functions have to be installed
    // before the prelude runs (the prelude binds against them), so at the time
    // this is constructed `__loop_invoke` does not exist yet. Looking it up
    // eagerly captures undefined and every Lua callback silently no-ops.
    let fn: ((h: number, ...a: unknown[]) => unknown) | undefined;
    return (handle, ...args) => {
        if (handle < 0) return undefined;
        fn ??= lua.global.get("__loop_invoke") as typeof fn;
        if (!fn) return undefined;
        try {
            return fn(handle, ...args);
        } catch (err) {
            onError(err);
            return undefined;
        }
    };
}

export interface SurfaceDeps {
    api: ExtensionAPI;
    lua: LuaEngine;
    invoke: Invoke;
    own: LuaRuntimeOwnership;
    /** Reported to the user when a script throws; also used for loop.log. */
    log: (message: string) => void;
    onError: (where: string, err: unknown) => void;
}

/** A status-line contributor registered from Lua, in registration order. */
interface LuaStatusContributor {
    handle: number;
}

/**
 * Install the `__loop_host_*` globals the prelude binds against. Called once
 * per VM generation, before any user script runs.
 */
export function installHostFunctions(deps: SurfaceDeps): void {
    const { api, lua, invoke, own, log, onError } = deps;
    const g = lua.global;

    g.set("__loop_host_version", () => api.version);
    g.set("__loop_host_log", (msg: unknown) => log(String(msg ?? "")));
    g.set("__loop_host_cwd", () => process.cwd());
    g.set("__loop_host_now", () => Date.now());
    g.set("__loop_host_screen", () => api.screen() ?? { rows: 24, cols: 80 });
    // Local wall-clock parts. `os.date` is not in the sandbox, and epoch
    // milliseconds alone cannot be turned into local time inside Lua — it has
    // no way to know the machine's timezone or its DST offset.
    g.set("__loop_host_time", () => {
        const d = new Date();
        return {
            hour: d.getHours(),
            min: d.getMinutes(),
            sec: d.getSeconds(),
            ms: d.getMilliseconds(),
            day: d.getDate(),
            month: d.getMonth() + 1,
            year: d.getFullYear(),
            // 1 = Sunday, matching Lua's own os.date("*t") convention.
            wday: d.getDay() + 1,
            weekday: d.toLocaleDateString(undefined, { weekday: "long" }),
            month_name: d.toLocaleDateString(undefined, { month: "long" }),
            epoch_ms: d.getTime(),
        };
    });
    g.set("__loop_host_redraw", () => api.statusLine.refresh());

    // ── status line ──────────────────────────────────────────────────────
    const contributors: LuaStatusContributor[] = [];
    g.set("__loop_host_statusline_add", (handle: unknown) => {
        const h = asNumber(handle);
        if (h === undefined) return;
        contributors.push({ handle: h });
        // One JS contributor per Lua one keeps loop's own ordering and its
        // per-contributor error isolation intact.
        api.statusLine.add((ctx: StatusLineContext) => luaStatusSegment(invoke, h, ctx));
    });

    // ── slash commands ───────────────────────────────────────────────────
    g.set("__loop_host_cmd_register", (name: unknown, description: unknown, handle: unknown) => {
        const cmdName = asString(name);
        const h = asNumber(handle);
        if (!cmdName || h === undefined) return;
        api.commands.register({
            name: cmdName,
            description: asString(description) || `Lua command: ${cmdName}`,
            handler: (ctx, args) => {
                const out = invoke(h, args ?? "");
                const text = asString(out);
                // "help" is the event that prints into the chat. There is no
                // "info" event — emitting one is silently dropped, which is
                // exactly how a command can look registered, autocomplete
                // correctly, run, and still show the user nothing.
                if (text) ctx.emit("help", text);
            },
        });
    });

    // ── processes ────────────────────────────────────────────────────────
    g.set("__loop_host_spawn", (cmd: unknown, args: unknown, cwd: unknown, handle: unknown) => {
        const command = asString(cmd);
        if (!command) return;
        const argv = argvOf(args);
        const h = asNumber(handle) ?? -1;
        try {
            const child = spawn(command, argv, {
                cwd: asString(cwd) || process.cwd(),
                stdio: ["ignore", "pipe", "pipe"],
            });
            own.children.add(child);
            let stdout = "";
            let stderr = "";
            child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
            child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
            child.on("error", (err) => {
                own.children.delete(child);
                if (h >= 0) invoke(h, -1, "", String(err));
            });
            child.on("close", (code) => {
                own.children.delete(child);
                if (h >= 0) invoke(h, code ?? -1, stdout, stderr);
            });
        } catch (err) {
            onError("loop.spawn", err);
        }
    });

    g.set("__loop_host_run", (cmd: unknown, args: unknown, cwd: unknown) => {
        const command = asString(cmd);
        if (!command) return { code: -1, stdout: "", stderr: "no command" };
        try {
            const res = spawnSync(command, argvOf(args), {
                cwd: asString(cwd) || process.cwd(),
                encoding: "utf8",
                timeout: 5000,
            });
            return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
        } catch (err) {
            return { code: -1, stdout: "", stderr: String(err) };
        }
    });

    // ── timers ───────────────────────────────────────────────────────────
    // Handed back to Lua as an opaque id; the timer object itself stays here so
    // dispose() can clear every one of them on reload.
    const timerIds = new Map<number, ReturnType<typeof setTimeout>>();
    let nextTimerId = 0;
    g.set("__loop_host_timer", (ms: unknown, handle: unknown, repeating: unknown) => {
        const delay = Math.max(1, asNumber(ms) ?? 1000);
        const h = asNumber(handle);
        if (h === undefined) return -1;
        const id = ++nextTimerId;
        const tick = (): void => {
            invoke(h);
            if (!repeating) {
                timerIds.delete(id);
                own.timers.delete(timer);
            }
        };
        const timer = repeating ? setInterval(tick, delay) : setTimeout(tick, delay);
        own.timers.add(timer as ReturnType<typeof setTimeout>);
        timerIds.set(id, timer as ReturnType<typeof setTimeout>);
        return id;
    });
    g.set("__loop_host_cancel", (id: unknown) => {
        const n = asNumber(id);
        if (n === undefined) return;
        const timer = timerIds.get(n);
        if (!timer) return;
        clearTimeout(timer);
        clearInterval(timer);
        timerIds.delete(n);
        own.timers.delete(timer);
    });

    // ── widgets ──────────────────────────────────────────────────────────
    // Handles stay here and Lua holds an integer id, for the same reason
    // callbacks never leave the VM: nothing that crosses the boundary needs to
    // survive a round trip.
    const widgetHandles = new Map<number, WidgetHandle>();
    let nextWidgetId = 0;
    g.set(
        "__loop_host_widget_show",
        (renderHandle: unknown, keyHandle: unknown, mouseHandle: unknown, opts: unknown) => {
            const rh = asNumber(renderHandle);
            if (rh === undefined) return -1;
            const kh = asNumber(keyHandle) ?? -1;
            const mh = asNumber(mouseHandle) ?? -1;
            const handle = api.widgets.show(
                {
                    render: (width: number) => toStringArray(invoke(rh, width)),
                    handleInput: kh >= 0 ? (data: string) => invoke(kh, data) === true : undefined,
                    handleMouse:
                        mh >= 0
                            ? (event: WidgetMouseEvent) =>
                                  invoke(mh, {
                                      type: event.type,
                                      button: event.button,
                                      x: event.x,
                                      y: event.y,
                                      screen_x: event.screenX,
                                      screen_y: event.screenY,
                                      shift: event.shift,
                                      alt: event.alt,
                                      ctrl: event.ctrl,
                                  }) === true
                            : undefined,
                },
                widgetOptions(opts),
            );
            // Print mode has no screen: `show` returns undefined and the script gets
            // an id that every method safely ignores, rather than an error at load.
            if (!handle) return -1;
            const id = ++nextWidgetId;
            widgetHandles.set(id, handle);
            own.widgets.add(handle);
            return id;
        },
    );
    const widget = (id: unknown): WidgetHandle | undefined => {
        const n = asNumber(id);
        return n === undefined ? undefined : widgetHandles.get(n);
    };
    g.set("__loop_host_widget_hide", (id: unknown) => {
        const h = widget(id);
        if (!h) return;
        h.hide();
        own.widgets.delete(h);
        const n = asNumber(id);
        if (n !== undefined) widgetHandles.delete(n);
    });
    g.set("__loop_host_widget_set_hidden", (id: unknown, hidden: unknown) => {
        widget(id)?.setHidden(hidden === true);
    });
    g.set("__loop_host_widget_set_pos", (id: unknown, row: unknown, col: unknown) => {
        const r = asNumber(row);
        const c = asNumber(col);
        if (r !== undefined && c !== undefined) widget(id)?.setPosition(r, c);
    });
    g.set("__loop_host_widget_pos", (id: unknown) => widget(id)?.getPosition());
    g.set("__loop_host_widget_is_hidden", (id: unknown) => widget(id)?.isHidden() ?? true);
    g.set("__loop_host_widget_focus", (id: unknown) => widget(id)?.focus());
    g.set("__loop_host_widget_unfocus", (id: unknown) => widget(id)?.unfocus());

    // ── docks ────────────────────────────────────────────────────────────
    const dockHandles = new Map<number, DockHandle>();
    let nextDockId = 0;
    g.set("__loop_host_dock_open", (renderHandle: unknown, keyHandle: unknown, size: unknown, side: unknown) => {
        const rh = asNumber(renderHandle);
        if (rh === undefined) return -1;
        const kh = asNumber(keyHandle) ?? -1;
        const handle = api.docks.open(
            {
                render: (width: number) => toStringArray(invoke(rh, width)),
                handleInput: kh >= 0 ? (data: string) => invoke(kh, data) === true : undefined,
            },
            { size: asNumber(size) ?? 10, side: (asString(side) as "bottom") ?? "bottom" },
        );
        if (!handle) return -1;
        const id = ++nextDockId;
        dockHandles.set(id, handle);
        own.docks.add(handle);
        return id;
    });
    const dock = (id: unknown): DockHandle | undefined => {
        const n = asNumber(id);
        return n === undefined ? undefined : dockHandles.get(n);
    };
    g.set("__loop_host_dock_close", (id: unknown) => {
        const d = dock(id);
        if (!d) return;
        d.close();
        own.docks.delete(d);
        const n = asNumber(id);
        if (n !== undefined) dockHandles.delete(n);
    });
    g.set("__loop_host_dock_set_size", (id: unknown, rows: unknown) => {
        const n = asNumber(rows);
        if (n !== undefined) dock(id)?.setSize(n);
    });
    g.set("__loop_host_dock_is_open", (id: unknown) => dock(id)?.isOpen() ?? false);
    g.set("__loop_host_dock_focus", (id: unknown) => dock(id)?.focus());
    g.set("__loop_host_dock_unfocus", (id: unknown) => dock(id)?.unfocus());
    g.set("__loop_host_dock_is_focused", (id: unknown) => dock(id)?.isFocused() ?? false);

    // ── terminal ─────────────────────────────────────────────────────────
    // A terminal is a dock whose renderer is the live session. The dock opens
    // immediately and the session attaches when its machinery has loaded, so a
    // script never has to await anything.
    interface LuaTerm {
        dock?: DockHandle;
        session?: TerminalHandle;
        rows: number;
        closed: boolean;
        error?: string;
    }
    const terms = new Map<number, LuaTerm>();
    let nextTermId = 0;

    g.set("__loop_host_term_open", (size: unknown, cmd: unknown, cwd: unknown, focus: unknown) => {
        const rows = Math.max(2, asNumber(size) ?? 12);
        const id = ++nextTermId;
        const state: LuaTerm = { rows, closed: false };
        terms.set(id, state);

        // One row of the panel is a title bar, so the terminal is visibly a
        // panel and not loose output pasted under the conversation.
        const header = (width: number): string => {
            const focused = state.dock?.isFocused() ?? false;
            const label = focused ? " terminal — ctrl+/ closes it " : " terminal — click or ctrl+/ to focus ";
            const bar = label.length >= width ? label.slice(0, width) : label;
            return `\x1b[2m─${bar}${"─".repeat(Math.max(0, width - bar.length - 1))}\x1b[0m`;
        };

        const dock = api.docks.open(
            {
                render: (width: number) => {
                    if (state.error) return [header(width), `  terminal unavailable: ${state.error}`];
                    if (!state.session) return [header(width), "  starting terminal…"];
                    // The session gets the rows left after the title bar; the
                    // dock clips to its own height either way, but telling the
                    // pty the real number is what keeps the shell's own cursor
                    // maths right.
                    return [header(width), ...state.session.render(width)];
                },
                // Everything typed goes to the shell while the panel has focus —
                // including ctrl+c, which must interrupt the child rather than
                // loop. Returning true is what keeps it from reaching the editor.
                handleInput: (data: string) => {
                    state.session?.handleInput(data);
                    return true;
                },
            },
            { size: rows, side: "bottom" },
        );
        if (!dock) {
            terms.delete(id);
            return -1;
        }
        state.dock = dock;
        if (focus !== false) dock.focus();

        void api.terminal
            .spawn({
                cmd: asString(cmd),
                cwd: asString(cwd) || process.cwd(),
                rows,
                isFocused: () => state.dock?.isFocused() ?? false,
                onUpdate: () => api.statusLine.refresh(),
                onExit: () => {
                    // The shell exited (the user typed `exit`): take the panel
                    // with it, the way closing a VS Code terminal does.
                    if (state.closed) return;
                    state.closed = true;
                    state.dock?.close();
                    terms.delete(id);
                    api.statusLine.refresh();
                },
            })
            .then((session) => {
                if (state.closed) {
                    session.kill();
                    return;
                }
                state.session = session;
                // One row goes to the title bar.
                session.resize(Math.max(1, rows - 1), 80);
                api.statusLine.refresh();
            })
            .catch((err: unknown) => {
                state.error = err instanceof Error ? err.message : String(err);
                onError("loop.term.open", err);
                api.statusLine.refresh();
            });

        return id;
    });

    const term = (id: unknown): LuaTerm | undefined => {
        const n = asNumber(id);
        return n === undefined ? undefined : terms.get(n);
    };
    g.set("__loop_host_term_close", (id: unknown) => {
        const t = term(id);
        if (!t || t.closed) return;
        t.closed = true;
        t.session?.kill();
        t.dock?.close();
        const n = asNumber(id);
        if (n !== undefined) terms.delete(n);
    });
    g.set("__loop_host_term_is_open", (id: unknown) => {
        const t = term(id);
        return Boolean(t && !t.closed);
    });
    g.set("__loop_host_term_focus", (id: unknown) => term(id)?.dock?.focus());
    g.set("__loop_host_term_unfocus", (id: unknown) => term(id)?.dock?.unfocus());
    g.set("__loop_host_term_is_focused", (id: unknown) => term(id)?.dock?.isFocused() ?? false);
    g.set("__loop_host_term_send", (id: unknown, text: unknown) => {
        const t = term(id);
        const s = asString(text);
        if (t && s !== undefined) t.session?.write(s);
    });
    g.set("__loop_host_term_set_size", (id: unknown, rows: unknown) => {
        const t = term(id);
        const n = asNumber(rows);
        if (!t || n === undefined) return;
        t.rows = Math.max(2, n);
        t.dock?.setSize(t.rows);
        t.session?.resize(Math.max(1, t.rows - 1), 80);
    });

    // ── keymaps ──────────────────────────────────────────────────────────
    const keymapDisposers = new Map<number, () => void>();
    let nextKeymapId = 0;
    g.set("__loop_host_keymap_set", (key: unknown, handle: unknown) => {
        const k = asString(key);
        const h = asNumber(handle);
        if (!k || h === undefined) return -1;
        const dispose = api.keymap.set(k, () => {
            const result = invoke(h);
            // Only an explicit `false` declines the key; nil/true consume it, so
            // a handler that just does its work doesn't also type a character.
            return result !== false;
        });
        const id = ++nextKeymapId;
        keymapDisposers.set(id, dispose);
        own.keymaps.add(dispose);
        return id;
    });
    g.set("__loop_host_keymap_del", (id: unknown) => {
        const n = asNumber(id);
        if (n === undefined) return;
        const dispose = keymapDisposers.get(n);
        if (!dispose) return;
        dispose();
        keymapDisposers.delete(n);
        own.keymaps.delete(dispose);
    });

    // ── settings ─────────────────────────────────────────────────────────
    g.set("__loop_host_setting_get", (key: unknown, fallback: unknown) => {
        const k = asString(key);
        if (!k) return fallback;
        return api.settings.getOwn(k, fallback);
    });
    g.set("__loop_host_setting_set", (key: unknown, value: unknown) => {
        const k = asString(key);
        if (k) api.settings.setOwn(k, value);
    });
}

/** Turn whatever a Lua status contributor returned into loop's segment shape. */
function luaStatusSegment(invoke: Invoke, handle: number, ctx: StatusLineContext): StatusSegment | string | null {
    const result = invoke(handle, {
        agent: ctx.agent,
        model: ctx.model,
        provider: ctx.provider,
        modelId: ctx.modelId,
        sessionId: ctx.sessionId ?? "",
        cwd: ctx.cwd,
        width: ctx.width,
        thinking: ctx.thinking,
        reasoning: ctx.reasoning,
        cost_usd: ctx.cost.usd,
        context_used: ctx.context.used,
        context_max: ctx.context.max,
    });
    if (result === null || result === undefined) return null;
    const text = asString(result);
    if (text !== undefined) return text;
    const record = toRecord(result);
    const segText = asString(record.text);
    if (segText === undefined) return null;
    return { text: segText, row: asNumber(record.row) };
}

/** Lua's snake_case placement table -> the API's camelCase options. */
function widgetOptions(value: unknown): WidgetOptions {
    const o = toRecord(value);
    return {
        anchor: asString(o.anchor),
        width: asNumber(o.width) ?? asString(o.width),
        minWidth: asNumber(o.min_width),
        maxHeight: asNumber(o.max_height) ?? asString(o.max_height),
        offsetX: asNumber(o.offset_x),
        offsetY: asNumber(o.offset_y),
        row: asNumber(o.row) ?? asString(o.row),
        col: asNumber(o.col) ?? asString(o.col),
        nonCapturing: asBoolean(o.non_capturing),
    };
}

function argvOf(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [Number(k), v] as const)
        .filter(([k]) => Number.isFinite(k))
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => String(v));
}
