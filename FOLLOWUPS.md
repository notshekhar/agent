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

---

## 3. The source-control UI is mid-redesign

**Where:** `apps/web/src/components/scm/`, plus the `scm` surface registered in
`rightPanelStore.ts`, `RightPanelTabs.tsx` and `ChatView.tsx`.

**What prompted it.** The first version rendered the file list as a strip above
the diff. That was wrong twice over: it competed for height with the patch it
describes, and it read nothing like the source-control view anyone who has used
VS Code expects.

**What has changed so far.** Source Control is now its own right-panel surface
alongside Files and Diff, with its own header, branch name and refresh, and it
polls so the agent's own commits show up. It owns its status rather than
borrowing the diff panel's. Rows are dense, and each row's status letter swaps
for its stage/discard buttons on hover, so the controls never widen the row or
push the filename around.

**What is still not right**, and is the reason this entry exists:

- **No tree view.** VS Code offers list *and* tree, with the tree collapsing
  common directory prefixes. With thirty changed files under `apps/web/src/...`
  the flat list is mostly repeated path.
- **No hunk affordances in the diff itself.** The engine is done and tested
  (`applyLineChanges.ts`, `parseHunks.ts`, `stageHunk.ts` — including line-level
  selection), but nothing in the diff view offers a gutter control to stage a
  hunk or a selection. That is the last piece of the staging feature.
- **No inline commit box.** VS Code's message field and Commit button live at
  the top of this view; loop's commit flow is still the header's stacked action.
- **The merge editor does not exist.** `conflictStages` reads base/ours/theirs
  out of the index and is tested; the three-pane view on top of it is not built.
- **The surface has not been confirmed on screen.** It typechecks and builds,
  and the panel underneath it has been driven end to end, but the last few
  attempts to open the new tab under automation clicked the wrong element. Open
  it by hand before trusting it.

---

## 4. The diff panel's scope picker was removed, and should come back deliberately

**Where:** `apps/web/src/components/DiffPanel.tsx`, where a `DropdownMenu`
offering "Working tree", "Branch changes", "Latest turn" and a specific turn
used to sit in the header.

**Why it went.** It mostly offered ways to end up looking at something other
than the work in progress. Turn-scoped diffs in particular assume changes are
followed turn by turn, which is not how this project is worked on, and the
picker's presence made the panel's default state ambiguous — a stored selection
of "branch changes" would silently persist across sessions.

**What is still there.** All of it, minus the control: `selectedTurnId`,
`selectTurn`, `orderedTurnDiffSummaries`, the checkpoint-diff query and the
whole branch-range source are untouched and working. `selectedGitScope` is
pinned to `"unstaged"`, which is the only line that has to change to bring the
choice back.

**If it returns**, the two things to decide first: where the control lives now
that the header also carries commit/push and the per-file revert, and whether a
scope should persist across sessions at all — reopening the panel to a
half-remembered comparison is what made the old one confusing.

---

## 4. The diff panel's scope picker was removed, and should come back deliberately

**Where:** `apps/web/src/components/DiffPanel.tsx`, where a `DropdownMenu`
offering "Working tree", "Branch changes", "Latest turn" and a specific turn
used to sit in the header.

**Why it went.** Turn-scoped diffs assume changes are followed turn by turn,
which is not how this project is worked on, so the picker mostly offered ways to
end up looking at something other than the work in progress — and a stored
selection of "branch changes" persisted across sessions, making the panel's
default state ambiguous.

**What is still there.** All of it, minus the control: `selectedTurnId`,
`selectTurn`, `orderedTurnDiffSummaries`, the checkpoint-diff query and the
branch-range source are untouched and working. `selectedGitScope` is pinned to
`"unstaged"`, which is the only line that has to change to offer the choice
again.

**If it returns**, two things to decide first: where the control lives now that
the header also carries commit/push, and whether a scope should persist across
sessions at all — reopening the panel to a half-remembered comparison is what
made the old one confusing.
