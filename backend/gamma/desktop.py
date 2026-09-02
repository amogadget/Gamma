"""Desktop-app support: where the library lives, which port to serve on, and
making sure only one instance owns that library at a time.

The hosted deployment never imports this. It exists for the double-clickable
app, where there is no terminal to read a port from, no shell to set
GAMMA_DATA_DIR in, and no second chance if two copies open the same SQLite
files. Design: docs/dev/client-app.md.
"""

import json
import os
import socket
import sys
import time
from pathlib import Path

# Addresses that mean "this machine". Used by the auto-session guard in
# auth.py — see desktop_auto_user() there for why loopback matters.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"})

# Headers a reverse proxy adds. Their presence means the peer address is the
# proxy's, not the caller's, so "the request came from this machine" can no
# longer be concluded from it.
PROXY_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host")

PREFERRED_PORT = 9001
STATE_FILE = "desktop.json"
LOCK_FILE = "desktop.lock"


def default_data_dir() -> Path:
    """Where a desktop instance keeps its library, per platform convention.

    macOS  ~/Library/Application Support/Gamma
    Windows %LOCALAPPDATA%\\Gamma
    Linux  $XDG_DATA_HOME/gamma, else ~/.local/share/gamma

    Chosen so the library survives replacing the app, and so Time Machine (and
    the equivalents elsewhere) pick it up without being told.
    """
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Gamma"
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")
        return Path(base) / "Gamma"
    base = os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")
    return Path(base) / "gamma"


def is_loopback(host: str) -> bool:
    return (host or "").strip().lower() in LOOPBACK_HOSTS


def port_is_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def pick_port(preferred: int = PREFERRED_PORT, host: str = "127.0.0.1") -> int:
    """`preferred` when it is free, else a port the OS chooses.

    Sticking to 9001 when possible keeps bookmarks and the browser extension's
    configured URL working across restarts; falling back keeps the app
    launching when something else already holds it.
    """
    if port_is_free(preferred, host):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


# --- the running-instance record ---------------------------------------------
# The app shell needs to find a live instance (to focus its window instead of
# starting a second server). A file is enough and survives the shell crashing.


def state_path(data_dir: Path) -> Path:
    return Path(data_dir) / STATE_FILE


def write_state(data_dir: Path, port: int) -> Path:
    p = state_path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({
        "port": int(port),
        "pid": os.getpid(),
        "started_at": time.time(),
    }), encoding="utf-8")
    return p


def read_state(data_dir: Path) -> dict | None:
    try:
        return json.loads(state_path(data_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def clear_state(data_dir: Path) -> None:
    try:
        state_path(data_dir).unlink()
    except OSError:
        pass


def pid_alive(pid: int) -> bool:
    """Whether `pid` exists. A stale state file (hard reboot, SIGKILL) must not
    convince the shell that an instance is already running."""
    if not pid or pid <= 0:
        return False
    if os.name == "nt":  # pragma: no cover - exercised on Windows only
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    return True


def running_instance(data_dir: Path) -> dict | None:
    """The live instance's state, or None. Clears a stale record as a side
    effect so the next launch is not blocked by a crash."""
    st = read_state(data_dir)
    if not st:
        return None
    if not pid_alive(st.get("pid", 0)):
        clear_state(data_dir)
        return None
    return st


class AlreadyRunning(RuntimeError):
    """Another instance holds the lock. Carries its state when known."""

    def __init__(self, state: dict | None = None):
        super().__init__("another Gamma instance is already running")
        self.state = state or {}

    @property
    def port(self) -> int:
        return int(self.state.get("port") or 0)


class SingleInstance:
    """An advisory lock on the library directory, held for the process's life.

    Two servers on two ports against one set of SQLite files is the failure
    this prevents: writes from both, and the second instance's `pages.db`
    connection seeing the first's uncommitted state. Cheap to hold, and the OS
    releases it if the process dies however badly.
    """

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / LOCK_FILE
        self._fh = None

    def acquire(self) -> "SingleInstance":
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "a+")
        try:
            if os.name == "nt":  # pragma: no cover - exercised on Windows only
                import msvcrt
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self._fh.close()
            self._fh = None
            raise AlreadyRunning(read_state(self.data_dir))
        return self

    def release(self) -> None:
        if not self._fh:
            return
        try:
            if os.name == "nt":  # pragma: no cover
                import msvcrt
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            self._fh.close()
            self._fh = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()
        return False
