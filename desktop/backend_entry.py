"""Entry point for the frozen (PyInstaller) Gamma server the desktop shell
bundles. Sets the env config BEFORE importing gamma (gamma/config.py reads the
environment at import time), then runs uvicorn programmatically.

Dev mode never uses this file — the shell runs `python -m uvicorn app:app`
from the repo's backend/ directly.
"""

import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="Gamma desktop local server")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    os.environ["GAMMA_DATA_DIR"] = args.data_dir
    # The built frontend is bundled as data files next to the frozen code
    # (PyInstaller extracts/keeps them under sys._MEIPASS in onedir mode).
    bundle_root = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    static = os.path.join(bundle_root, "frontend_dist")
    if os.path.isdir(static):
        os.environ.setdefault("GAMMA_STATIC_DIR", static)

    import uvicorn
    from gamma.app import app

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
