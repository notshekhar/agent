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


SCENARIOS = {
    "boot": test_boot,
    "growth": test_no_duplicates_while_growing,
    "completion": test_completion_list_costs_nothing,
    "selector": test_selector_costs_nothing,
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
