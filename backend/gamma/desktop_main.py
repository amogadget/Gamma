"""Entry point for the desktop app: `python -m gamma.desktop_main`.

Resolves the library directory, claims the single-instance lock, picks a port,
then serves on loopback only. Prints one machine-readable line the app shell
parses to learn where to point its window:

    GAMMA_READY {"port": 9001, "pid": 4242, "data_dir": "/…/Gamma", "url": "…"}

Everything about *why* it is shaped this way is in docs/dev/client-app.md.
"""

import json
import os
import signal
import sys
from pathlib import Path

from .desktop import (
    AlreadyRunning,
    SingleInstance,
    clear_state,
    default_data_dir,
    pick_port,
    running_instance,
    write_state,
)

READY_PREFIX = "GAMMA_READY"
BUSY_PREFIX = "GAMMA_ALREADY_RUNNING"
HOST = "127.0.0.1"


def resolve_data_dir() -> Path:
    """GAMMA_DATA_DIR when set (tests, or a user pointing at another library),
    else the platform's application-support location."""
    return Path(os.environ.get("GAMMA_DATA_DIR") or default_data_dir())


def _emit(prefix: str, payload: dict) -> None:
    """One line, prefix + JSON, flushed. The shell reads stdout line by line;
    anything else on stdout is log noise it ignores."""
    print(f"{prefix} {json.dumps(payload)}", flush=True)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    data_dir = resolve_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)

    # The desktop launcher owns these: the rest of the package reads them from
    # config, which snapshots the environment at import time — so they must be
    # set before gamma.app is imported, below.
    os.environ["GAMMA_DATA_DIR"] = str(data_dir)
    os.environ.setdefault("GAMMA_DESKTOP", "1")

    # Already running? Report where, and leave its library alone. The shell
    # focuses that instance's window instead of starting a second server.
    existing = running_instance(data_dir)
    if existing:
        _emit(BUSY_PREFIX, {"port": existing.get("port"), "pid": existing.get("pid")})
        return 3

    try:
        lock = SingleInstance(data_dir).acquire()
    except AlreadyRunning as e:
        # Lock held but no usable state file — a sibling is mid-startup.
        _emit(BUSY_PREFIX, {"port": e.port, "pid": e.state.get("pid")})
        return 3

    try:
        port = pick_port() if "--port" not in argv else int(argv[argv.index("--port") + 1])

        # Imported only now, so it sees the environment set above.
        from .seed import ensure_desktop_user
        from .static_paths import resolve_static_dir

        static = resolve_static_dir()
        if static:
            os.environ["GAMMA_STATIC_DIR"] = str(static)

        user = ensure_desktop_user()

        import uvicorn

        from .app import app

        write_state(data_dir, port)
        _emit(READY_PREFIX, {
            "port": port,
            "pid": os.getpid(),
            "data_dir": str(data_dir),
            "user": user,
            "url": f"http://{HOST}:{port}/",
            "static": str(static or ""),
        })

        server = uvicorn.Server(uvicorn.Config(
            app, host=HOST, port=port, log_level="info",
            # The shell sends SIGTERM on quit; uvicorn's handler drains
            # in-flight requests before returning from run().
            timeout_graceful_shutdown=10,
        ))

        # Quit means quit: without this a SIGTERM during startup could leave
        # the process alive holding the lock.
        def _bye(_signum, _frame):
            server.should_exit = True

        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(sig, _bye)
            except (ValueError, OSError):  # pragma: no cover - non-main thread
                pass

        server.run()
        return 0
    finally:
        clear_state(data_dir)
        lock.release()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
