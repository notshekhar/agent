# Scripting loop with Lua

Drop a `.lua` file into `~/.loop/lua/` and it runs the next time loop starts.
No package, no `npm install`, no build step — the way a Neovim or wezterm config
works.

Enable it once:

```
loop enable lua
```

Then create `~/.loop/lua/init.lua`:

```lua
loop.statusline.add(function(ctx)
    return { text = "⎇ " .. ctx.cwd:match("[^/]+$"), row = 1 }
end)
```

`/lua` shows which scripts loaded and where they live; `/lua reload` re-runs them
without restarting loop.

## Writing a script for someone (agents, read this)

If you are an agent and the user asks for a widget, a panel, a status-line
addition, a keybinding or a terminal, **write a Lua file — do not build an
extension.** The whole loop is:

1. Make sure the runtime is on: `loop enable lua` (once per machine).
2. Write `~/.loop/lua/<name>.lua`. One file, no package.json, no install, no
   build step, no dependencies.
3. Run `/reload` — or tell the user to. It re-runs every script from disk, so
   the change is live in the same session. (`/lua reload` does the Lua half
   alone.)
4. Check `/lua` if something did not appear: it lists what loaded and prints the
   file and line of anything that failed.

Keep each feature in its own file (`clock.lua`, `git.lua`) so one broken script
never takes the others down — a failing file is reported and skipped.

Two rules that save a debugging session:

- **`#s` is bytes, not columns.** Box-drawing and accented characters are
  multi-byte, so use `utf8.len(s)` for anything you are lining up. Getting this
  wrong silently draws a box three times too wide.
- **Nothing repaints on its own.** After changing state from a timer or a
  callback, call `loop.redraw()`.

## Lua vs. extensions

Extensions (Bun/TypeScript, see `extensions.md`) reach loop's internals: tools,
providers, agents, the turn loop. They are packages, and they install.

Lua is for the things you'd otherwise never bother packaging — a status-line
segment, a shortcut, a bit of glue. It is a *file*, not a package. Anything Lua
can do, an extension can also do; the difference is ceremony.

## Load order

`init.lua` runs first, then every other `*.lua` in `~/.loop/lua/`
alphabetically. Subdirectories are **not** auto-loaded — they are for `require`:

```
~/.loop/lua/
    init.lua          -- runs first
    git.lua           -- then this
    lib/helpers.lua   -- only when required
```

```lua
local helpers = require("lib.helpers")   -- ~/.loop/lua/lib/helpers.lua
```

A module returns its table:

```lua
-- lib/helpers.lua
local M = {}
function M.short(path) return path:match("[^/]+$") end
return M
```

A script that fails to load is reported by path and line, and the others still
run. `require` cannot reach outside `~/.loop/lua`.

## The `loop` table

### Status line

```lua
loop.statusline.add(function(ctx)
    if ctx.context_used > ctx.context_max * 0.8 then
        return { text = "ctx high", row = 1 }
    end
end)
```

Return a `{ text, row }` table, a bare string (appended to the usage row), or
nothing. `row`: `0` = the agent/model row, `1` = the usage row, `2+` = a new row.

`ctx` carries `agent`, `model`, `provider`, `modelId`, `sessionId`, `cwd`,
`width`, `thinking`, `reasoning`, `cost_usd`, `context_used`, `context_max`.

Contributors run on **every repaint**, so keep them cheap — cache anything
expensive and refresh it on a timer. Use `loop.redraw()` to repaint after a
value changes on its own.

### Slash commands

```lua
loop.cmd.register({
    name = "branch",
    description = "show the current git branch",
    handler = function(args)
        local code, out = loop.run("git", { args = { "rev-parse", "--abbrev-ref", "HEAD" } })
        return code == 0 and out or "not a git repo"
    end,
})
```

Whatever the handler returns as a string is printed into the chat; return
nothing to print nothing. The argument is everything after the command name, as
a string — `""` when there is none, never nil.

Commands are registered at startup, so they appear in the `/` completion list
straight away. Editing a script needs `/reload` (or `/lua reload`) to take
effect, like any other change.

### Running commands

`loop.run` blocks and returns `code, stdout, stderr` — for something short:

```lua
local code, out = loop.run("git", { args = { "status", "--short" }, cwd = loop.cwd() })
```

`loop.spawn` does not block; the callback fires later:

```lua
loop.spawn("npm", {
    args = { "test" },
    on_exit = function(code, out, err) TEST_STATUS = code == 0 and "pass" or "fail" end,
})
```

A status-line function cannot wait for a result — it draws whatever a callback
stored earlier. That is the shape of every live value here.

### Timers

```lua
local id = loop.interval(5000, function()
    local _, out = loop.run("git", { args = { "status", "--porcelain" } })
    DIRTY = #out > 0
    loop.redraw()
end)

loop.timer(1000, function() loop.log("once") end)
loop.cancel(id)
```

Timers are torn down on reload and on exit, so `/lua reload` never leaves one
running.

### Widgets

A widget is a table with `render(width)` returning lines. **The table you pass
*is* the widget** — placement fields sit on it alongside the methods, and `self`
inside `render` is that same table, which is where per-widget state lives:

```lua
local W = { ticks = 0, anchor = "center", width = 46, offset_y = -1 }

function W:render(width)
    return { "ticks: " .. self.ticks }
end

function W:on_key(data)
    if data == "j" then self.ticks = self.ticks + 1 return true end
    return false   -- let every other key through
end

local handle = loop.widget.show(W)
```

Passing a fresh table that only *copies* the methods (`{ render = W.render }`)
also works, but then `self` is that new table and `W`'s state is not there —
usually not what you want.

Placement, all optional: `anchor` (`"center"`, `"top-left"`, `"top-right"`,
`"bottom-left"`, `"bottom-right"`, `"top-center"`, `"bottom-center"`,
`"left-center"`, `"right-center"`), `width`, `min_width`, `max_height`,
`offset_x`, `offset_y`, `row`, `col`. Sizes take a number of columns/rows or a
percentage string like `"50%"`.

By default a widget does **not** take keyboard focus, so the user keeps typing
underneath it and `on_key` never fires. Set `non_capturing = false` to have it
take focus and receive keys.

The handle:

```lua
handle:hide()          -- remove it for good
handle:set_hidden(true) -- temporarily
handle:toggle()
handle:visible()
handle:focus()  handle:unfocus()
```

A render that errors shows a one-line error in place of the widget rather than
breaking the frame, and the message is reported once rather than once per frame.

Nothing repaints on its own — after changing state from a timer or a callback,
call `loop.redraw()`.

### Mouse and dragging

Add `on_mouse(ev)` to a widget. Return true to consume the event, false to let
it through to the terminal's own text selection:

```lua
function W:on_mouse(ev)
    if ev.type == "press" and ev.button == 0 then
        self.grab = { x = ev.x, y = ev.y }      -- where inside the box we grabbed
        return true
    elseif ev.type == "drag" and self.grab then
        self.handle:set_pos(ev.screen_y - self.grab.y, ev.screen_x - self.grab.x)
        return true
    elseif ev.type == "release" then
        self.grab = nil
        return true
    end
    return false
end
```

That is the whole of dragging — loop routes the event and nothing more. The
position, the grab offset and the decision to consume are all yours.

`ev` carries `type` (`"press"`, `"drag"`, `"release"`, `"move"`), `button`
(0 left, 1 middle, 2 right), `x`/`y` relative to the widget's top-left corner,
`screen_x`/`screen_y` absolute, and `shift`/`alt`/`ctrl`. All coordinates are
0-based.

A press you consume captures the drag: every event until release goes to that
widget even once the pointer leaves it, which is what dragging by an edge needs.

```lua
handle:set_pos(row, col)   -- absolute screen position, 0-based
handle:pos()               -- { row = …, col = … } once painted
```

**Return false for what you don't use.** Consuming an event also suppresses the
terminal's text selection, scrollbar drags and link clicks for that event — so a
widget that consumes everything makes the region under it feel broken. Mouse
wheel events are never delivered; scrolling belongs to the transcript.

### Docked panels

A dock takes rows **from** the transcript instead of drawing over it — VS Code's
bottom panel. Same `render(width)` contract as a widget:

```lua
local P = { size = 8, lines = {} }

function P:refresh()
    local _, status = loop.run("git", { args = { "status", "--short" } })
    self.lines = {}
    for line in status:gmatch("[^%c]+") do self.lines[#self.lines + 1] = line end
    loop.redraw()
end

function P:render(width)
    local rows = { "── git " .. string.rep("─", width - 7) }
    for i = 1, #self.lines do rows[#rows + 1] = "  " .. self.lines[i] end
    return rows
end

P:refresh()
local dock = loop.dock.open(P)
loop.interval(2000, function() P:refresh() end)
```

`size` is the height in rows (default 10); output is padded or clipped to
exactly that, so the panel never jitters as its content changes. `side` is
`"bottom"` — between the transcript and the input box.

```lua
dock:close()
dock:set_size(14)
dock:is_open()
dock:focus()  dock:unfocus()  dock:is_focused()
```

A dock only receives keys through `on_key` while focused, and focus is not taken
automatically — call `dock:focus()`.

Opening a dock switches the session to the pinned-input layout for as long as
one is open, and switches back when the last closes. Your saved `pinnedInput`
setting is not modified.

Note that `loop.dock.open` needs a screen, so call it from a key binding or a
command rather than at the top level of a script — during startup there is not
one yet. (Widgets and key bindings *are* queued and applied once the screen
exists, so those are fine at the top level.)

### A terminal

A real shell in a docked panel, VS Code style:

```lua
local term = nil

local function toggle()
    if term and term:is_open() then
        term:close()
        term = nil
    else
        term = loop.term.open({ size = 14 })
    end
end

loop.keymap.set("ctrl+/", toggle)   -- modern terminals
loop.keymap.set("ctrl+-", toggle)   -- older ones send the same byte for both
```

`loop.term.open{ size, cmd, cwd, focus }` — `cmd` defaults to your `$SHELL`,
`focus` defaults to true. It returns nil where the platform has no pty support.

```lua
term:close()  term:is_open()
term:focus()  term:unfocus()  term:is_focused()
term:send("ls\n")      -- type into it from a script
term:set_size(20)
```

The panel takes the keyboard when it opens, so **everything you type goes to the
shell** — including ctrl+c, which interrupts the command rather than loop. Keys
bound with `loop.keymap.set` still work, which is how you get back out: the
toggle above closes the panel and returns the keyboard to the prompt. Always
bind a key that closes or unfocuses a terminal, or there is no way out of it.

The shell exiting (`exit`, or ctrl+d) closes the panel on its own.

### Full-screen widgets (games, viewers)

`render(width)` is told how wide it may draw but never how tall, because most
widgets are simply as tall as the lines they return. Anything filling the screen
asks:

```lua
local screen = loop.screen()   -- { rows = 45, cols = 180 }
```

The pattern for something that owns the whole terminal:

```lua
local Game = {
    non_capturing = false,      -- take the keyboard
    width = "100%", max_height = "100%", row = 0, col = 0,
}

function Game:render(width)
    local rows = loop.screen().rows
    local out = {}
    for y = 1, rows do out[y] = ... end   -- exactly `rows` lines, `width` wide
    return out
end

function Game:on_key(data)
    if data == "\27" then handle:hide(); return true end   -- esc closes
    ...
    loop.redraw()
    return true
end
```

Two things to get right. **Always give it a key that closes it** — a widget with
`non_capturing = false` owns every keystroke, so without one the only way out is
quitting loop. And **arrow keys arrive as escape sequences** (`"\27[A"`,
`"\27[B"`, `"\27[C"`, `"\27[D"`), so compare esc against exactly `"\27"`
rather than testing a prefix, or an arrow key will close your widget.

For colour, half-block characters double your vertical resolution: draw `▀` with
the foreground as the top pixel and the background as the bottom one, and one
row of cells becomes two rows of pixels.

Performance is not usually the limit — a full-screen 180x45 scene with per-cell
colour renders in about 4ms — but the escape sequences are: emit a colour code
only when the colour actually changes, and hoist anything that depends only on
the row out of the per-pixel loop.

### Key bindings

```lua
loop.keymap.set("ctrl+g", function()
    if HANDLE then HANDLE:hide(); HANDLE = nil
    else HANDLE = loop.widget.show(W) end
end)
```

Key ids are loop's own: `"ctrl+g"`, `"alt+w"`, `"f5"`, `"shift+tab"`. The
handler runs **before** the editor sees the key, so a binding beats typing —
return `false` to let the key through anyway. `loop.keymap.del(id)` removes one.

Two things worth knowing. A binding replaces whatever loop did with that key for
as long as it is set, so avoid the ones you rely on (`ctrl+c`, `ctrl+e`). And
`ctrl+/` is not bindable: terminals send the same byte for `ctrl+/` and
`ctrl+-`, so ask for `"ctrl+-"`.

Widgets and bindings are interactive-only — in `loop run` (print mode) `show`
returns a handle that does nothing and bindings never fire.

### Settings and odds and ends

```lua
loop.settings.set("greeting", "hi")
loop.settings.get("greeting", "default")   -- second arg is the fallback
loop.log("message")                        -- prints into the chat as a note
loop.cwd()  loop.now()  loop.redraw()  loop.version
```

Settings are namespaced to the Lua extension and persist in `settings.json`.

## Methods on a table

Both declaration forms work — loop checks the declared parameter count and
passes `self` only when the function expects it:

```lua
local W = { count = 0 }
function W:bump(by) self.count = self.count + by end   -- colon
function W.plain(x) return x * 2 end                   -- dot
```

For a **vararg** method the two forms are indistinguishable, so a vararg
callback registered on a table is treated as the colon form (`self` first).
Register a bare function instead if that isn't what you want.

## What a script can and cannot do

`io`, `os`, `package`, `debug`, `require`'s C loader, `load` and `dofile` are
removed. File and process access go through `loop.*`, where they are visible.

Each VM has a 32 MB memory ceiling and a 250 ms per-call timeout, so an
accidental `while true do end` raises an error instead of freezing loop, and the
session survives it.

**These are guardrails against mistakes, not a security boundary.** A script
that can run `git` can run anything you can. That is why only your own
`~/.loop/lua/` is loaded — nothing project-local runs automatically, and a
`.lua` file inside a repository you cloned is never executed.
