#!/usr/bin/env python3
"""Drive loop's TUI in a real pty and report what the terminal actually saw.

Why this exists
---------------
The pinned-prompt work shipped three bugs that every unit test passed through:

  * the request for wheel reports was written BEFORE terminal.start(), whose
    stale-mode cleanse wiped it — the window scrolled perfectly on any wheel
    report it was handed, and was never handed one;
  * teardown reset the kitty protocol, modifyOtherKeys and bracketed paste but
    not mouse reporting, so quitting left the shell echoing `\x1b[<64;20;5M`
    at every scroll;
  * a short transcript did not pin at all, because clipping only engaged once
    the transcript overflowed;
  * and the window loop was clipping turned out to be scrollback taken away
    from the terminal — which is what killed drag-to-select.

None of the three is visible from inside the process. They are properties of
the byte stream between loop and the terminal, and of where things land on a
fixed-size screen — so they need a pty and a terminal emulator to see.

Usage
-----
    python3 scripts/tui-probe.py screen     # where things land on a 24x100 screen
    python3 scripts/tui-probe.py modes      # order of every mouse-mode sequence
    python3 scripts/tui-probe.py exit       # is the terminal restored on quit?

    python3 scripts/tui-probe.py screen --no-pin      # same, setting off
    python3 scripts/tui-probe.py screen --rows 40 --cols 120

Requires `pyte` (pip install pyte). Runs loop from source with `bun`, against a
throwaway HOME so your real settings and sessions are untouched.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import struct
import sys
import tempfile
import termios
import time

REPO = pathlib.Path(__file__).resolve().parent.parent


def run_loop(home: pathlib.Path, settings: dict, rows: int, cols: int):
    """Fork loop under a pty. Returns (pid, fd)."""
    cfg = home / ".loop"
    cfg.mkdir(parents=True, exist_ok=True)
    (cfg / "settings.json").write_text(json.dumps(settings))
    # Pre-trust, so the trust prompt does not eat the keystrokes we send.
    (cfg / "trust.json").write_text(json.dumps({str(REPO): {"trusted": True}}))

    env = dict(os.environ)
    env.update(HOME=str(home), TERM="xterm-256color", COLORTERM="truecolor")

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(REPO)
        os.execvpe("bun", ["bun", "packages/cli/src/cli.ts"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    return pid, fd


class Session:
    def __init__(self, home, settings, rows, cols):
        import pyte

        self.rows, self.cols = rows, cols
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = bytearray()
        self.pid, self.fd = run_loop(home, settings, rows, cols)

    def pump(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if not r:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            if not data:
                return
            self.raw.extend(data)
            self.stream.feed(data)

    def send(self, data: bytes, settle: float = 0.6) -> None:
        os.write(self.fd, data)
        self.pump(settle)

    def settle(self) -> None:
        """Wait out startup, then clear anything modal."""
        self.pump(8)
        self.send(b"\r", 1.5)

    def fill(self, times: int = 5) -> None:
        """Put enough in the transcript that it has to scroll."""
        for _ in range(times):
            self.send(b"/help\r", 1.2)
        self.pump(1.5)

    def text(self) -> str:
        return self.raw.decode("utf-8", "replace")

    def show(self, label: str) -> None:
        print(f"\n--- {label} ({self.cols}x{self.rows}) ---")
        for i, line in enumerate(self.screen.display, start=1):
            print(f"{i:3} |{line.rstrip()}")

    def quit(self, timeout: float = 15.0) -> bool:
        """Ctrl+C twice, then wait for it to actually go.

        Polled rather than checked once: loop's clean exit races SessionEnd
        hooks and gateway teardown behind a timeout of its own, so a single
        WNOHANG right after the keystroke reports a live process and makes a
        working quit look broken.
        """
        os.write(self.fd, b"\x03")
        time.sleep(0.3)
        os.write(self.fd, b"\x03")
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.5)
            try:
                wpid, _ = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                return True
            if wpid != 0:
                return True
        return False

    def kill(self) -> None:
        try:
            os.kill(self.pid, 9)
        except ProcessLookupError:
            pass


MODE_RE = re.compile(r"\x1b\[\?(?:1000|1002|1003|1006|1049)[hl]")


def mode_events(text: str):
    return [m.group(0) for m in MODE_RE.finditer(text)]


def show_modes(events) -> None:
    for seq in events:
        print(f"  {seq.encode().decode('unicode_escape')!r}")


def cmd_screen(s: Session, args) -> int:
    s.settle()
    s.fill()
    s.show("screen")
    rules = [i + 1 for i, l in enumerate(s.screen.display) if l.strip().startswith("─" * 20)]
    print(f"\nprompt box rows: {rules}")
    # "Prompt at the bottom" alone proves nothing: once the transcript fills
    # the screen the terminal scrolls and the prompt ends up on the last rows
    # either way. What only pinning produces is a CLIPPED transcript — loop
    # owning the scroll instead of handing it to the terminal's scrollback.
    clipped = any("more line" in l for l in s.screen.display)
    print(f"transcript is a clipped window (loop owns the scroll): {clipped}")
    return 0


def cmd_modes(s: Session, args) -> int:
    """Pinning must leave the mouse alone: reporting is what costs you selection."""
    s.settle()
    s.fill(2)
    events = mode_events(s.text())
    print("mouse-mode sequences, in the order loop wrote them:")
    show_modes(events)
    enabled = [e for e in events if e.endswith("h")]
    print(f"\nmodes ENABLED: {[e.encode().decode('unicode_escape') for e in enabled] or 'none'}")
    print(
        "the terminal keeps the mouse (selection + scrollback work)"
        if not enabled
        else "loop is holding the mouse — drag-select is dead while it does"
    )
    return 0 if not enabled else 1


def cmd_exit(s: Session, args) -> int:
    s.settle()
    s.fill(2)
    before = len(s.raw)
    exited = s.quit()
    events = mode_events(s.text())
    after = [e for e, pos in zip(events, [m.start() for m in MODE_RE.finditer(s.text())]) if pos >= before]
    print(f"loop exited on its own: {exited}")
    print("mouse-mode sequences after the quit:")
    show_modes(after)
    last = events[-1] if events else None
    ok = bool(last and last.endswith("l"))
    print(f"\nlast: {last!r} -> {'OK, terminal restored' if ok else 'LEAK: shell inherits a reporting terminal'}")
    return 0 if ok else 1


COMMANDS = {"screen": cmd_screen, "modes": cmd_modes, "exit": cmd_exit}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=sorted(COMMANDS))
    ap.add_argument("--rows", type=int, default=24)
    ap.add_argument("--cols", type=int, default=100)
    ap.add_argument("--no-pin", action="store_true", help="run with pinnedInput off")
    args = ap.parse_args()

    try:
        import pyte  # noqa: F401
    except ImportError:
        print("this probe needs pyte:  pip install pyte", file=sys.stderr)
        return 2
    if not shutil.which("bun"):
        print("this probe runs loop from source and needs bun on PATH", file=sys.stderr)
        return 2

    settings = {"uiMode": "noir", "uiLive": True}
    if not args.no_pin:
        settings["pinnedInput"] = True

    home = pathlib.Path(tempfile.mkdtemp(prefix="loop-tui-probe-"))
    s = None
    try:
        s = Session(home, settings, args.rows, args.cols)
        return COMMANDS[args.command](s, args)
    finally:
        if s:
            s.kill()
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
