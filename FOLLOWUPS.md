# Known gaps, deliberately deferred

Work that was left undone on purpose, with enough context to pick it up cold.
Each entry says what is missing, why it was skipped, and where to start — so
nobody has to re-derive the reasoning from the diff.

Delete an entry when it lands. This file is for gaps we chose, not a wishlist.

---

## 1. Restarting to install an update can discard a running turn

**Where:** `apps/web/src/components/sidebar/SidebarUpdatePill.tsx` (the
`install` action) and `apps/desktop/src/updateManager.ts` (`install()`).

**What happens today.** When an update has been downloaded, the pill offers
Restart. It calls `installUpdate()`, which swaps the install and then
`app.relaunch()` + `app.quit()`. Nothing asks whether an agent turn is in
flight. loop persists a turn only when it ends (see the `foldLiveTurn` comment
in `apps/web/src/loop/handlers/thread.ts`), so quitting mid-turn loses whatever
that turn had produced — and the confirmation dialog the pill already shows
talks about restarting, not about losing work.

**Why it was left.** The updater shipped in v0.17.0 and the gap is narrow: the
user has to click Restart while a turn is running. Getting it right means
deciding the *policy* — block, warn, or wait — and that is a product call, not a
mechanical fix.

**Where to start.** The renderer already knows: a thread snapshot carries
`running`, and `activeTurnId` is non-null exactly while a turn is in flight. The
cheap version is to disable the Restart button with a tooltip while any session
is running. The better version is to keep the update staged and install on the
next quit, which costs nothing to the user — the download has already happened,
and `swapInstall` is fast because it is two renames.

---

## 2. The Windows update swap has never been run on Windows

**Where:** `writeWindowsSwapScript` in `apps/desktop/src/updater.ts`, and the
`win32` branch of `UpdateManager.install()`.

**What is unverified.** macOS and Linux swap in place, and both were exercised
against real archives — a real `ditto` zip through `extractRelease` and
`swapInstall`, with the bundle genuinely replaced. Windows cannot swap in place
because the loader keeps a running `.exe` locked, so it writes a `.cmd` that
polls `tasklist` for our pid, moves the directories, relaunches with `start ""`
and deletes itself. **That script's contents are unit-tested; the script has
never actually executed.** No Windows machine ran it.

**Specific things most likely to be wrong**, in rough order:

- `tasklist /FI "PID eq <pid>" | find "<pid>"` is a common idiom but its exit
  code behaviour is fiddly; a wrong sense on the `errorlevel` check turns the
  wait loop into either a spin or an immediate swap while the app is still
  holding its files.
- `move` across volumes fails on Windows where it would succeed on POSIX. An
  install on `C:` updating from a temp dir on another drive would hit this. The
  work dir comes from `makeWorkDir()` (`os.tmpdir()`), so this is plausible, not
  hypothetical — staging beside the install directory instead would avoid it.
- A path containing spaces is quoted throughout, but `%~f0` self-deletion while
  the script is still executing is timing-dependent on some Windows versions.
- The relaunch inherits the helper's environment, not the original app's.

**How to verify without guessing.** Package a win32 build (it cross-builds from
macOS — see `apps/desktop/package-app.ts`), install it on a Windows machine or
VM, publish a newer tag, and take the update. Watch that the app comes back on
its own and that no `.old` directory is left behind. Until someone does that,
treat Windows in-app updating as unproven; `install-desktop.ps1` still works and
is the fallback to tell a Windows user about.
