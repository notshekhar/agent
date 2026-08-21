"""
A loop TUI test harness that cannot lie.

Driving a TUI from a test is easy to do badly, and a harness that measures the
wrong thing is worse than no harness — it reports success. Three specific ways
that happened while this suite was being written, each closed here:

  * shared state — a HOME reused across runs meant one run's agent.db (and one
    run's surviving process) decided the next run's behaviour. Every session
    gets its own mkdtemp HOME, thrown away after.
  * stray processes — a pattern kill reaped things it did not spawn. Nothing
    here kills by pattern: the child's pid is captured at fork and only that
    pid is ever signalled, then reaped with waitpid.
  * a terminal that does not answer — loop probes the terminal (CPR for width
    calibration, DA, cell size, background colour) and falls back on a timeout
    when nothing replies, so a dumb pipe measures the FALLBACK path, not the
    one users run. A pyte screen consumes the output stream and answers the
    probes from its own cursor, the way a real emulator does.

Screens come back from that same pyte model, so what is asserted is what a
terminal would actually show.
"""

import os
import pty
import re
import select
import signal
import shutil
import struct
import fcntl
import tempfile
import termios
import time

import pyte

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
CLI = os.path.join(REPO, "packages", "cli", "src", "cli.ts")

# Probes loop sends that a real terminal answers. Left unanswered they each
# cost a timeout and push loop down a fallback path.
CPR = re.compile(rb"\x1b\[6n")
DA = re.compile(rb"\x1b\[c")
CELL_SIZE = re.compile(rb"\x1b\[16t")
KITTY_QUERY = re.compile(rb"\x1b\[\?u")
OSC_BG = re.compile(rb"\x1b\]11;\?(?:\x07|\x1b\\)")


class Session:
    def __init__(self, settings="{}", cols=100, rows=30, cwd=None, env_extra=None):
        self.cols, self.rows = cols, rows
        self.home = tempfile.mkdtemp(prefix="loop-harness-")
        os.makedirs(f"{self.home}/.loop/agent", exist_ok=True)
        with open(f"{self.home}/.loop/settings.json", "w") as fh:
            fh.write(settings)
        # A fresh empty project: trust is keyed per folder in SQLite and only
        # asked for when the folder ships .loop/.claude resources, so an empty
        # one opens with no modal eating the scripted keystrokes.
        self.project = cwd or tempfile.mkdtemp(prefix="loop-project-")
        cwd = self.project

        self.screen = pyte.HistoryScreen(cols, rows, history=4000)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""
        self._marks = {}

        env = dict(
            os.environ,
            HOME=self.home,
            TERM="xterm-256color",
            COLUMNS=str(cols),
            LINES=str(rows),
        )
        env.pop("LOOP_SPAWN_BINARY", None)
        if env_extra:
            env.update(env_extra)

        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe("bun", ["bun", CLI], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    # -- the terminal side ------------------------------------------------
    def _answer_probes(self, chunk):
        """Reply to what a real terminal would reply to."""
        if CPR.search(chunk):
            # pyte has already consumed this chunk, so its cursor is where the
            # app's cursor is — which is the whole point of the probe.
            for _ in CPR.findall(chunk):
                row, col = self.screen.cursor.y + 1, self.screen.cursor.x + 1
                os.write(self.fd, f"\x1b[{row};{col}R".encode())
        if CELL_SIZE.search(chunk):
            os.write(self.fd, b"\x1b[6;17;8t")  # 17x8 px cells
        if DA.search(chunk):
            os.write(self.fd, b"\x1b[?62;c")
        if KITTY_QUERY.search(chunk):
            os.write(self.fd, b"\x1b[?0u")  # no kitty keyboard protocol
        if OSC_BG.search(chunk):
            os.write(self.fd, b"\x1b]11;rgb:1414/1414/1414\x1b\\")

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if not r:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.raw += chunk
            self.stream.feed(chunk)
            self._answer_probes(chunk)

    def send(self, data, settle=0.9):
        os.write(self.fd, data.encode())
        self.pump(settle)

    # -- what the user would see ------------------------------------------
    def screen_rows(self):
        return [line.rstrip() for line in self.screen.display]

    def history_rows(self):
        """Lines that have scrolled off the top — the terminal's scrollback."""
        return ["".join(line[x].data for x in range(self.cols)).rstrip() for line in self.screen.history.top]

    def dump(self, label):
        print(f"\n===== {label} (scrollback {len(self.screen.history.top)}) =====")
        for i, line in enumerate(self.screen_rows()):
            print(f"{i:2}|{line}")

    def close(self):
        try:
            os.write(self.fd, b"\x03\x03")
            self.pump(0.6)
        except OSError:
            pass
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.time() + 3
        while time.time() < deadline:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                break
            time.sleep(0.05)
        else:
            try:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        try:
            os.close(self.fd)
        except OSError:
            pass
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.project, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
