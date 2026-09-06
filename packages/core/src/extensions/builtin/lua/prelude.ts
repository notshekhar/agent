/**
 * The Lua-side runtime: the `loop` table scripts talk to, and the callback
 * registry behind it.
 *
 * Why the API is written in Lua rather than injected from JS: a Lua function
 * handed out to JS and passed back in arrives as a *JS* function wrapper, which
 * loses its identity — `debug.getinfo` then reports a C function with zero
 * parameters, and any attempt to tell `function W:render(w)` from
 * `function W.render(w)` fails silently, shifting every argument by one.
 *
 * So callbacks never leave the VM. Scripts register tables and functions here;
 * Lua keeps them in `_reg` and hands JS an integer handle. The host invokes a
 * callback by handle through `__loop_invoke`, and only plain data — strings,
 * numbers, booleans, and flat tables of those — ever crosses the boundary.
 *
 * Host functions this expects (injected by surface.ts as `__loop_host_*`) take
 * a handle plus plain values and return plain values.
 */
export const LUA_PRELUDE = `
local _getinfo = __loop_getinfo
local _reg, _next = {}, 0

-- Register a callback. \`obj\` + \`key\` for a method on a table, or just a
-- function. Returns an integer handle the host uses to invoke it.
local function register(obj, key)
  _next = _next + 1
  if key ~= nil then _reg[_next] = { obj = obj, fn = obj[key] }
  else _reg[_next] = { obj = nil, fn = obj } end
  return _next
end

local function unregister(h) _reg[h] = nil end

-- Invoked by the host. Decides between the colon and dot declaration forms by
-- comparing the function's declared parameter count against the arguments
-- actually being passed, so both \`function W:render(w)\` and
-- \`function W.render(w)\` receive \`w\` in the right place.
--
-- Varargs are the ambiguous case: \`function W:render(...)\` reports one fixed
-- parameter (the implicit self) and so does \`function W.render(a, ...)\`, and
-- nothing distinguishes them. Registered callbacks on a table are treated as
-- the colon form, which is the idiom people actually write; a vararg callback
-- that does NOT want self should be registered as a bare function.
local function wants_self(fn, argc)
  local info = _getinfo(fn, "u")
  if not info then return false end
  if info.nparams > argc then return true end
  return info.isvararg and info.nparams >= 1 and info.nparams <= argc
end

function __loop_invoke(h, ...)
  local e = _reg[h]
  if not e or type(e.fn) ~= "function" then return nil end
  if e.obj ~= nil and wants_self(e.fn, select("#", ...)) then return e.fn(e.obj, ...) end
  return e.fn(...)
end

-- Re-read a method that the script replaced after registering (scripts do
-- reassign \`W.render\` while iterating on a widget).
function __loop_refresh(h, key)
  local e = _reg[h]
  if e and e.obj ~= nil and key ~= nil then e.fn = e.obj[key] end
end

loop = {}

loop.version = __loop_host_version()

function loop.log(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
  __loop_host_log(table.concat(parts, " "))
end

loop.notify = loop.log

-- ── status line ──────────────────────────────────────────────────────────
loop.statusline = {}

function loop.statusline.add(fn)
  return __loop_host_statusline_add(register(fn))
end

function loop.statusline.refresh() __loop_host_redraw() end

-- ── slash commands ───────────────────────────────────────────────────────
loop.cmd = {}

function loop.cmd.register(spec)
  assert(type(spec) == "table", "loop.cmd.register expects a table")
  assert(type(spec.name) == "string", "loop.cmd.register: name is required")
  assert(type(spec.handler) == "function", "loop.cmd.register: handler is required")
  return __loop_host_cmd_register(spec.name, spec.description or "", register(spec.handler))
end

-- ── processes ────────────────────────────────────────────────────────────
-- Non-blocking. \`on_exit(code, stdout, stderr)\` fires on a later tick, so a
-- render function must draw from state a callback filled in earlier, never
-- wait for one.
function loop.spawn(cmd, opts)
  opts = opts or {}
  local h = opts.on_exit and register(opts.on_exit) or -1
  return __loop_host_spawn(cmd, opts.args or {}, opts.cwd, h)
end

-- Blocking; for short, fast commands only. Returns code, stdout, stderr.
function loop.run(cmd, opts)
  opts = opts or {}
  local r = __loop_host_run(cmd, opts.args or {}, opts.cwd)
  return r.code, r.stdout, r.stderr
end

-- ── timers ───────────────────────────────────────────────────────────────
function loop.timer(ms, fn) return __loop_host_timer(ms, register(fn), false) end
function loop.interval(ms, fn) return __loop_host_timer(ms, register(fn), true) end
function loop.cancel(id) __loop_host_cancel(id) end

-- ── widgets ──────────────────────────────────────────────────────────────
-- A widget is any table with a \`render(width)\` returning a list of lines, and
-- optionally \`on_key(data)\` returning true to swallow the key. It is the same
-- contract loop's own TUI components use.
loop.widget = {}

local Widget = {}
Widget.__index = Widget

function Widget:hide() __loop_host_widget_hide(self._id) end
function Widget:show() __loop_host_widget_set_hidden(self._id, false) end
function Widget:set_hidden(h) __loop_host_widget_set_hidden(self._id, h and true or false) end
function Widget:is_hidden() return __loop_host_widget_is_hidden(self._id) end
function Widget:visible() return not self:is_hidden() end
function Widget:toggle() self:set_hidden(not self:is_hidden()) end
function Widget:set_pos(row, col) __loop_host_widget_set_pos(self._id, row, col) end
function Widget:pos() return __loop_host_widget_pos(self._id) end
function Widget:focus() __loop_host_widget_focus(self._id) end
function Widget:unfocus() __loop_host_widget_unfocus(self._id) end
function Widget:redraw() __loop_host_redraw() end

-- \`spec\` carries the placement (anchor/width/offset/...) alongside \`render\`
-- and \`on_key\`, so a script describes a widget in one table.
function loop.widget.show(spec)
  assert(type(spec) == "table", "loop.widget.show expects a table")
  assert(type(spec.render) == "function", "loop.widget.show: render is required")
  local render_h = register(spec, "render")
  local key_h = spec.on_key and register(spec, "on_key") or -1
  local mouse_h = spec.on_mouse and register(spec, "on_mouse") or -1
  local id = __loop_host_widget_show(render_h, key_h, mouse_h, {
    anchor = spec.anchor,
    width = spec.width,
    min_width = spec.min_width,
    max_height = spec.max_height,
    offset_x = spec.offset_x,
    offset_y = spec.offset_y,
    row = spec.row,
    col = spec.col,
    -- Default to not stealing focus: a widget that silently swallows typing is
    -- a worse surprise than one that needs an explicit :focus().
    non_capturing = spec.non_capturing ~= false,
  })
  local w = setmetatable({ _id = id, spec = spec }, Widget)
  spec.handle = w
  return w
end

-- ── docks ────────────────────────────────────────────────────────────────
-- A dock takes rows FROM the transcript instead of drawing over it — VS Code's
-- bottom panel. Same \`render(width)\` contract as a widget; the output is padded
-- or clipped to \`size\` rows, so the panel's height never jitters.
loop.dock = {}

local Dock = {}
Dock.__index = Dock

function Dock:close() __loop_host_dock_close(self._id) end
function Dock:set_size(rows) __loop_host_dock_set_size(self._id, rows) end
function Dock:is_open() return __loop_host_dock_is_open(self._id) end
function Dock:focus() __loop_host_dock_focus(self._id) end
function Dock:unfocus() __loop_host_dock_unfocus(self._id) end
function Dock:is_focused() return __loop_host_dock_is_focused(self._id) end
function Dock:redraw() __loop_host_redraw() end

function loop.dock.open(spec)
  assert(type(spec) == "table", "loop.dock.open expects a table")
  assert(type(spec.render) == "function", "loop.dock.open: render is required")
  local render_h = register(spec, "render")
  local key_h = spec.on_key and register(spec, "on_key") or -1
  local id = __loop_host_dock_open(render_h, key_h, spec.size or 10, spec.side or "bottom")
  local d = setmetatable({ _id = id, spec = spec }, Dock)
  spec.handle = d
  return d
end

-- ── terminal ─────────────────────────────────────────────────────────────
-- A real shell in a docked panel, VS Code style. The pty and its emulator load
-- on first use, so the panel shows "starting..." for a frame and then the shell
-- appears; nothing else in the script has to wait for it.
loop.term = {}

local Term = {}
Term.__index = Term

function Term:close() __loop_host_term_close(self._id) end
function Term:is_open() return __loop_host_term_is_open(self._id) end
function Term:focus() __loop_host_term_focus(self._id) end
function Term:unfocus() __loop_host_term_unfocus(self._id) end
function Term:is_focused() return __loop_host_term_is_focused(self._id) end
function Term:send(text) __loop_host_term_send(self._id, text) end
function Term:set_size(rows) __loop_host_term_set_size(self._id, rows) end

function loop.term.open(opts)
  opts = opts or {}
  local id = __loop_host_term_open(opts.size or 12, opts.cmd, opts.cwd, opts.focus ~= false)
  if id < 0 then return nil end
  return setmetatable({ _id = id }, Term)
end

-- ── keymaps ──────────────────────────────────────────────────────────────
-- Key ids are loop's own ("ctrl+g", "alt+w", "f5"). The handler runs before the
-- editor sees the key; return false to let it through anyway.
loop.keymap = {}

function loop.keymap.set(key, fn)
  assert(type(key) == "string", "loop.keymap.set: key must be a string")
  assert(type(fn) == "function", "loop.keymap.set: handler must be a function")
  return __loop_host_keymap_set(key, register(fn))
end

function loop.keymap.del(id) __loop_host_keymap_del(id) end

-- ── settings ─────────────────────────────────────────────────────────────
loop.settings = {}
function loop.settings.get(k, fallback) return __loop_host_setting_get(k, fallback) end
function loop.settings.set(k, v) __loop_host_setting_set(k, v) end

-- ── misc ─────────────────────────────────────────────────────────────────
function loop.cwd() return __loop_host_cwd() end
function loop.now() return __loop_host_now() end
-- Terminal size in cells: { rows = , cols = }. A widget's render is told its
-- width but not its height, so anything filling the screen needs this.
function loop.screen() return __loop_host_screen() end
-- Local wall-clock parts: hour, min, sec, ms, day, month, year, wday,
-- weekday, month_name, epoch_ms. (os.date is not in the sandbox.)
function loop.time() return __loop_host_time() end
function loop.redraw() __loop_host_redraw() end

__loop_internal = { register = register, unregister = unregister }
`;
