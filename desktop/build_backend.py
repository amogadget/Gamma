"""Freeze the Gamma backend into a self-contained folder the desktop shell
bundles as its local-workspace server.

Run with a Python that has backend/requirements.txt installed (the repo venv
locally, the CI interpreter on runners):

    python desktop/build_backend.py

Output: desktop/dist-backend/gamma-server/  (onedir bundle with the built
frontend/dist inside; electron-builder copies it into resources/gamma-server).
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DESKTOP = REPO / "desktop"
DIST = DESKTOP / "dist-backend"


def ensure_pyinstaller():
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("[build] installing pyinstaller ...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller"])


def main():
    frontend_dist = REPO / "frontend" / "dist"
    if not (frontend_dist / "index.html").exists():
        sys.exit("frontend/dist missing - run `npm run build` in frontend/ first")

    ensure_pyinstaller()
    if DIST.exists():
        shutil.rmtree(DIST)

    sep = os.pathsep  # --add-data uses ; on Windows, : elsewhere
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--name", "gamma-server",
        "--distpath", str(DIST),
        "--workpath", str(DESKTOP / "build" / "pyi-work"),
        "--specpath", str(DESKTOP / "build"),
        "--paths", str(REPO / "backend"),
        # The SPA the server serves; backend_entry points GAMMA_STATIC_DIR here.
        "--add-data", f"{frontend_dist}{sep}frontend_dist",
        # uvicorn resolves loop/protocol classes from strings at runtime.
        "--collect-all", "uvicorn",
        "--collect-all", "websockets",  # uvicorn loads its websocket protocol lazily
        # pypdfium2 ships its native library outside normal imports.
        "--collect-all", "pypdfium2",
        "--collect-all", "pypdfium2_raw",
        # Math typesetting fonts (STIXTwoMath / DejaVuSans live in package data).
        "--collect-data", "ziamath",
        "--collect-data", "ziafont",
        "--collect-data", "latex2mathml",
        str(DESKTOP / "backend_entry.py"),
    ]
    env = os.environ.copy()
    # Conda-based interpreters keep the DLLs their extension modules link
    # against (ffi.dll, sqlite3.dll, liblzma.dll, ...) in <env>\Library\bin,
    # which is not on PyInstaller's default DLL search path. Harmless no-op on
    # standard python.org / CI interpreters.
    lib_bin = Path(sys.base_prefix) / "Library" / "bin"
    if lib_bin.is_dir():
        env["PATH"] = str(lib_bin) + os.pathsep + env.get("PATH", "")
        print(f"[build] added DLL search path: {lib_bin}")

    print("[build]", " ".join(cmd))
    subprocess.check_call(cmd, cwd=str(REPO), env=env)
    exe = "gamma-server.exe" if os.name == "nt" else "gamma-server"
    print(f"[build] done: {DIST / 'gamma-server' / exe}")


if __name__ == "__main__":
    main()
