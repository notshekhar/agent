#!/usr/bin/env python3
"""
End-to-end screen tests for the TUI.

The renderer's bugs do not show up in unit tests, because none of them are
about what a component renders — they are about where the terminal ends up
putting it. A conversation printed twice into the scrollback, a blank band
where a menu closed, /new leaving the previous session on screen: every one of
those is a correct frame, drawn wrong. The only way to catch them is to run
loop in a real pty and look at the screen.

Two invariants carry most of the weight:

  NOTHING IS EVER PRINTED TWICE. A line that has scrolled off is committed; the
  terminal cannot be made to move it, only to print it again. So a duplicate in
  the scrollback means the renderer tried to move history and made a copy.

  TRANSIENT UI COSTS THE FRAME NOTHING. Opening a menu or a completion list
  must not scroll the terminal, because the rows it scrolls off cannot come
  back when it closes — which is what leaves a band behind.

Run: python3 packages/cli/test/e2e/run.py [name ...]
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from harness import Session  # noqa: E402

NOIR = '{"uiMode": "noir"}'

failures = []
checks = 0


def check(cond, label, detail=""):
    global checks
    checks += 1
    if cond:
        print(f"    ok   {label}")
    else:
        print(f"    FAIL {label}")
        if detail:
            for line in str(detail).splitlines():
                print(f"         {line}")
        failures.append(label)


def duplicates(session, needle="filler "):
    """Lines printed more than once across scrollback + screen."""
    counts = {}
    for line in session.history_rows() + session.screen_rows():
        line = line.strip()
        if needle not in line:
            continue
        counts[line] = counts.get(line, 0) + 1
    return {line: n for line, n in counts.items() if n > 1}


def fill(session, n, settle=0.25):
    """A conversation taller than the screen, with identifiable lines."""
    for i in range(n):
        session.send(f"filler {i}\r", settle=settle)
    session.pump(0.8)


def blank_band(rows, size=3):
    """Index of a run of `size` blank rows, or -1 — the shape of a shrink gap."""
    for i in range(len(rows) - size + 1):
        if all(not rows[j].strip() for j in range(i, i + size)):
            return i
    return -1


# ---------------------------------------------------------------- scenarios


def test_boot():
    """The first screen: masthead, and a prompt block that is actually drawn."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        rows = s.screen_rows()
        check(any("Welcome back" in r for r in rows), "masthead is on screen")
        check(len(s.screen.history.top) == 0, "nothing scrolled off a fresh boot")
        check(any(r.strip().startswith("─") for r in rows), "the prompt block is on screen", rows)


def test_no_duplicates_while_growing():
    """A conversation past the fold is printed once, in order."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 30)
        dupes = duplicates(s)
        check(not dupes, "no line was printed twice while the transcript grew", dupes)
        printed = [r for r in s.history_rows() + s.screen_rows() if "filler " in r]
        order = [int(r.split("filler ")[1].split()[0]) for r in printed if r.split("filler ")[1].strip().isdigit()]
        check(order == sorted(order), "the transcript is in order", order[:40])


def test_completion_list_costs_nothing():
    """Typing `/` and deleting it must leave the screen exactly as it was."""
    for label, settings in (("noir", NOIR),):
        with Session(settings=settings) as s:
            s.pump(7)
            fill(s, 20)
            before = s.screen_rows()
            committed_before = len(s.screen.history.top)

            s.send("/", settle=1.6)
            open_rows = s.screen_rows()
            check(
                any("help" in r for r in open_rows),
                f"[{label}] the completion list is showing",
            )
            check(
                len(s.screen.history.top) == committed_before,
                f"[{label}] opening it scrolled nothing off",
                f"{len(s.screen.history.top) - committed_before} rows committed",
            )

            s.send("\x7f", settle=1.6)
            check(
                s.screen_rows() == before,
                f"[{label}] deleting it put the screen back exactly",
                "\n".join(f"{i:2}|{a!r} != {b!r}" for i, (a, b) in enumerate(zip(s.screen_rows(), before)) if a != b),
            )
            check(not duplicates(s), f"[{label}] and printed nothing twice", duplicates(s))


def test_selector_costs_nothing():
    """A menu opening and closing must not move the conversation."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 20)
        committed_before = len(s.screen.history.top)
        top_before = s.screen_rows()

        s.send("/settings\r", settle=3.0)
        rows = s.screen_rows()
        check(any("uiMode" in r for r in rows), "the settings menu is showing")
        # Running the command appends its own echo to the transcript ("/settings"
        # plus a blank), and on a full screen those two rows legitimately scroll
        # off. The MENU must cost nothing on top of that: inline it was fifteen
        # rows tall, and all fifteen came out of the top of the screen.
        echo_rows = 2
        committed = len(s.screen.history.top) - committed_before
        check(
            committed <= echo_rows,
            "the menu itself scrolled nothing off — only the command's echo",
            f"{committed} rows committed, at most {echo_rows} expected",
        )
        # Scrolling by the echo means row N of the new screen is row N+echo of
        # the old one — the conversation moved by exactly that and no more.
        check(
            s.screen_rows()[:6] == top_before[echo_rows : echo_rows + 6],
            "the transcript above the menu moved by exactly that echo",
            f"{s.screen_rows()[:3]}\n{top_before[echo_rows : echo_rows + 3]}",
        )

        s.send("\x1b", settle=2.5)
        after = s.screen_rows()
        check(blank_band(after[:20]) == -1, "no blank band where the menu was", after[:20])
        check(not duplicates(s), "and nothing was printed twice", duplicates(s))


def test_new_session():
    """/new on a long conversation starts clean: banner back, old chat gone."""
    for label, settings in (("noir", NOIR),):
        with Session(settings=settings) as s:
            s.pump(7)
            fill(s, 30)
            s.send("/new\r", settle=3.5)
            rows = s.screen_rows()
            check(any("Welcome back" in r for r in rows), f"[{label}] /new shows the masthead again", rows[:12])
            check(
                not any("filler " in r for r in rows),
                f"[{label}] /new leaves none of the old conversation on screen",
                [r for r in rows if "filler " in r][:5],
            )


def test_clear_screen():
    """/clear wipes the screen and starts the session's header again."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 30)
        s.send("/clear\r", settle=3.0)
        rows = s.screen_rows()
        check(any("Welcome back" in r for r in rows), "/clear shows the masthead again", rows[:12])
        check(not any("filler " in r for r in rows), "/clear leaves no old conversation on screen")


def test_shells_panel():
    """A background shell appears in the pinned panel without disturbing the
    conversation above it — and killing it does not strand a band."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 20)
        committed_before = len(s.screen.history.top)

        s.send("/shells run sleep 30\r", settle=2.0)
        rows = s.screen_rows()
        check(any("bash_1" in r for r in rows), "the shell shows up on screen", rows[-12:])
        check(not duplicates(s), "starting one printed nothing twice", duplicates(s))
        printed = [r for r in s.history_rows() + s.screen_rows() if "filler " in r]
        order = [int(r.split("filler ")[1].split()[0]) for r in printed if r.split("filler ")[1].strip().isdigit()]
        check(order == sorted(order), "the conversation above it is intact and in order", order[:40])

        # The panel grew the frame; growth is safe, but the rows it pushed off
        # must be exactly as many as it added, never a duplicated stretch.
        s.send("/shells\r", settle=1.5)
        check(any("bash_1" in r for r in s.screen_rows()), "/shells lists it")
        check(not duplicates(s), "listing printed nothing twice", duplicates(s))

        s.send("/shells kill all\r", settle=2.0)
        rows = s.screen_rows()
        check(any("Killed" in r for r in rows), "killing it is reported", rows[-12:])
        check(not duplicates(s), "killing printed nothing twice", duplicates(s))
        check(blank_band(s.screen_rows()) == -1, "no blank band was left behind", s.screen_rows())
        check(
            len(s.screen.history.top) >= committed_before,
            "history only ever grew",
        )


def test_shells_survive_esc():
    """esc ends a turn; it must not take a background shell with it."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        s.send("/shells run sleep 30\r", settle=2.0)
        s.send("\x1b", settle=0.6)
        s.send("\x1b", settle=0.6)
        s.send("/shells\r", settle=1.5)
        rows = s.screen_rows()
        check(any("running" in r for r in rows), "the shell is still running after esc", rows[-14:])
        s.send("/shells kill all\r", settle=1.5)


def test_resize():
    """A resize re-wraps without losing or duplicating the conversation."""
    import fcntl, struct, termios, signal  # noqa: E401

    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 20)
        fcntl.ioctl(s.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 90, 0, 0))
        os.kill(s.pid, signal.SIGWINCH)
        s.screen.resize(24, 90)
        s.rows, s.cols = 24, 90
        s.pump(2.5)
        rows = s.screen_rows()
        check(len(rows) == 24, "the frame follows the new height")
        check(any(r.strip() for r in rows), "the screen is not blank after a resize", rows)



def test_alt_screen_keeps_scrollback_clean():
    """The chat is on the alternate screen: nothing is committed while it runs.

    This is the property the alt screen was adopted for. Committed rows were
    the source of the duplicated chat, the blank bands and the stranded frames,
    because a row that has scrolled off can only be reprinted, never moved. On
    the alternate screen there are no committed rows at all — and the
    conversation is not lost either, because leaving the screen prints it once,
    whole, into the terminal.
    """
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 40)
        check(
            len(s.screen.history.top) == 0,
            "40 messages committed nothing to the terminal's scrollback",
            len(s.screen.history.top),
        )
        check(
            any(r.strip().startswith("\u2500") for r in s.screen_rows()),
            "the prompt is still drawn after a long conversation",
        )

        s.send("\x03", settle=0.4)
        s.send("\x03", settle=2.5)
        s.pump(2.0)
        left = [
            "".join(c.data for c in line.values()).rstrip() for line in s.screen.history.top
        ] + s.screen_rows()
        check(
            any("Welcome back" in r for r in left),
            "quitting prints the transcript into the terminal instead of losing it",
        )



def test_menu_anchors_to_the_frame_not_the_screen():
    """A menu on a SHORT conversation must not cover the editor's status rows.

    Overlays are anchored to where the frame's content ends, not to the bottom
    of the terminal. Those are the same row once the conversation fills the
    screen, and differ by one while it does not — so this only reproduces on a
    short transcript, which is why the other selector scenario (20 messages,
    frame already full) cannot see it. The alt-screen move first reported the
    padded viewport height as the content height and landed every menu one row
    low, over the "agent … (shift+tab)" line.
    """
    for label, keys in (("settings", "/settings\r"), ("completion", "/")):
        with Session(settings=NOIR) as s:
            s.pump(7)
            fill(s, 2)  # deliberately short: the frame must not fill the screen
            s.send(keys, settle=2.5)
            rows = s.screen_rows()
            check(
                any("shift+tab" in r for r in rows),
                f"[{label}] the menu left the editor's status rows visible",
                rows[-5:],
            )
            check(
                any("session" in r and "ctx" in r for r in rows),
                f"[{label}] and the session line below them too",
                rows[-3:],
            )



def test_menu_follows_the_prompt_when_scrolled():
    """With pinning off, the prompt scrolls away with the transcript — and a
    menu belongs to the prompt, not to the screen.

    What broke: overlays anchored to `rows - contentHeight`, the document's
    length, which knows nothing about where the window onto it is. Scrolled
    back, the prompt was below the screen and `/` or `/settings` painted a
    menu floating over the transcript with no prompt under it.

    The contract now: a key brings the prompt back into view (a shell scrolls
    to the bottom on a keystroke), so a menu always opens ON the prompt; and
    wheeling away while one is open takes the menu along — it is hidden with
    the prompt and back when either the wheel or a key returns.
    """
    up, down = "\x1b[<64;20;10M", "\x1b[<65;20;10M"
    prompt_rows = lambda rows: [i for i, r in enumerate(rows) if "agent default (shift+tab)" in r]
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 30)
        for _ in range(3):
            s.send(up, settle=0.12)
        s.pump(0.6)
        check(not prompt_rows(s.screen_rows()), "scrolled back, the prompt is off the screen")

        s.send("/", settle=1.6)
        rows = s.screen_rows()
        at = prompt_rows(rows)
        check(bool(at), "typing brought the prompt back", rows[-4:])
        listing = [i for i, r in enumerate(rows) if "help" in r and "Show available commands" in r]
        check(
            bool(listing) and at and listing[0] < at[0],
            "and the completion list opened above it, not floating in the transcript",
            rows[-12:],
        )

        for _ in range(3):
            s.send(up, settle=0.12)
        s.pump(0.6)
        rows = s.screen_rows()
        check(not prompt_rows(rows), "wheeling away takes the prompt off again")
        check(
            not any("Show available commands" in r for r in rows),
            "and the completion list went with it instead of floating",
            rows[-12:],
        )
        for _ in range(6):
            s.send(down, settle=0.1)
        s.pump(0.6)
        rows = s.screen_rows()
        check(
            any("Show available commands" in r for r in rows) and bool(prompt_rows(rows)),
            "wheeling back shows both again",
            rows[-12:],
        )

        s.send("\x7f", settle=1.0)
        for _ in range(3):
            s.send(up, settle=0.12)
        s.pump(0.6)
        s.send("/settings\r", settle=2.5)
        rows = s.screen_rows()
        at = prompt_rows(rows)
        menu = [i for i, r in enumerate(rows) if "uiMode" in r]
        check(bool(menu) and bool(at) and menu[0] < at[0], "/settings opens on the prompt too", rows[-8:])


def test_wheel_tail_yields_to_typing():
    """A trackpad keeps sending wheel-up for a few hundred ms after the fingers
    lift. Scroll back, start typing: the first key jumps to the prompt, and the
    tail must NOT drag the view up again — that was the prompt and the
    completion list flickering, and the jump "only working on the second key".

    The wheel yields to a keyboard jump for a moment (extended while keys keep
    coming), and is back to normal once the typing stops.
    """
    up = "\x1b[<64;20;10M"
    prompt_rows = lambda rows: [i for i, r in enumerate(rows) if "agent default (shift+tab)" in r]
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 30)
        for _ in range(4):  # the flick
            s.send(up, settle=0.03)
        s.send("h", settle=0.05)
        check(bool(prompt_rows(s.screen_rows())), "the FIRST key brings the prompt back", s.screen_rows()[-4:])
        # The tail keeps coming while the user types on. (pump() polls at 50 ms,
        # so each "60 ms" here can run to ~110; keys are interleaved densely,
        # the way typing actually is, rather than after a long silent tail.)
        for ch in "ey":
            for _ in range(2):
                s.send(up, settle=0.06)
            s.send(ch, settle=0.05)
        for _ in range(2):
            s.send(up, settle=0.06)
        s.pump(0.3)
        rows = s.screen_rows()
        check(bool(prompt_rows(rows)), "the tail did not drag the prompt away again", rows[-4:])
        check(any(r.strip() == "hey" for r in rows), "and what was typed is on it", rows[-6:])

        s.pump(0.6)  # the hold has lapsed
        for _ in range(3):
            s.send(up, settle=0.12)
        s.pump(0.5)
        check(not prompt_rows(s.screen_rows()), "a real scroll afterwards still works")


def test_wheel_scrolls_the_document():
    """The wheel scrolls the conversation, the way the terminal's own
    scrollback would — and the prompt goes with it, because it is part of
    the same document, exactly as it is when a shell command's output is
    scrolled back over.

    On the alternate screen there is no terminal scrollback, so the wheel has
    to reach loop or there is no scrolling at all. What broke it: loop's
    Terminal.start() cleanses stale modes (`?1000l ?1006l`) AFTER the alt
    screen asks for mouse tracking, switching it straight back off.
    """
    up, down = "\x1b[<64;20;10M", "\x1b[<65;20;10M"
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 30)
        rest = s.screen_rows()
        check(any("shift+tab" in r for r in rest[-5:]), "the prompt is drawn at rest")

        for _ in range(6):
            s.send(up, settle=0.12)
        s.pump(0.8)
        scrolled = s.screen_rows()
        check(rest[:6] != scrolled[:6], "the wheel scrolled the conversation", scrolled[:3])
        check(len(s.screen.history.top) == 0, "scrolling committed nothing to the terminal")
        # A real terminal only SENDS wheel reports to an app that asked for
        # them, and this harness sends them regardless — so the request itself
        # has to be asserted, or the cleanse switching mouse tracking back off
        # after startup goes unnoticed here.
        check(
            s.mouse_tracking_enabled(),
            "loop still has mouse tracking on after startup",
        )

        for _ in range(12):
            s.send(down, settle=0.1)
        s.pump(0.8)
        check(s.screen_rows() == rest, "scrolling back down returns to the live end")


def test_pinned_input():
    """`pinnedInput`: the prompt is held on the last rows from the first frame,
    the wheel scrolls only the transcript above it, and quitting still prints
    the whole conversation.

    The last point is the one that bit: the pinned frame is a VStack, and the
    exit path renders it WITHOUT a viewport, where a `basis: 0` transcript is
    zero rows — the conversation was gone from the terminal on quit.
    """
    up, down = "\x1b[<64;20;10M", "\x1b[<65;20;10M"
    # The status line under the editor, not the masthead's "shift+tab agents" hint.
    prompt_rows = lambda rows: [i for i, r in enumerate(rows) if "agent default (shift+tab)" in r]
    with Session(settings='{"uiMode": "noir", "pinnedInput": true}') as s:
        s.pump(7)
        boot = s.screen_rows()
        check(any("Welcome back" in r for r in boot), "masthead is on screen")
        at_boot = prompt_rows(boot)
        check(at_boot and at_boot[-1] >= len(boot) - 4, "the prompt is on the last rows from the start", at_boot)

        fill(s, 30)
        rest = s.screen_rows()
        for _ in range(6):
            s.send(up, settle=0.12)
        s.pump(0.8)
        scrolled = s.screen_rows()
        check(rest[:6] != scrolled[:6], "the wheel scrolled the transcript", scrolled[:3])
        check(prompt_rows(scrolled) == prompt_rows(rest), "and the prompt stayed put while it did")
        check(len(s.screen.history.top) == 0, "scrolling committed nothing to the terminal")
        for _ in range(12):
            s.send(down, settle=0.1)
        s.pump(0.8)
        check(s.screen_rows() == rest, "scrolling back down returns to the live end")

        s.send("\x03", settle=0.4)
        s.send("\x03", settle=2.5)
        s.pump(2.0)
        left = [
            "".join(c.data for c in line.values()).rstrip() for line in s.screen.history.top
        ] + s.screen_rows()
        check(any("Welcome back" in r for r in left), "quitting prints the whole transcript, masthead included")


SCENARIOS = {
    "boot": test_boot,
    "growth": test_no_duplicates_while_growing,
    "completion": test_completion_list_costs_nothing,
    "selector": test_selector_costs_nothing,
    "menu-anchor": test_menu_anchors_to_the_frame_not_the_screen,
    "menu-scrolled": test_menu_follows_the_prompt_when_scrolled,
    "wheel-tail": test_wheel_tail_yields_to_typing,
    "wheel": test_wheel_scrolls_the_document,
    "pinned": test_pinned_input,
    "new": test_new_session,
    "clear": test_clear_screen,
    "resize": test_resize,
    "alt-screen": test_alt_screen_keeps_scrollback_clean,
    "shells": test_shells_panel,
    "shells-esc": test_shells_survive_esc,
}


def main():
    wanted = sys.argv[1:] or list(SCENARIOS)
    for name in wanted:
        fn = SCENARIOS.get(name)
        if not fn:
            print(f"unknown scenario: {name} (have: {', '.join(SCENARIOS)})")
            return 2
        print(f"\n== {name} ==")
        fn()
    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        print("failed:")
        for f in failures:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
