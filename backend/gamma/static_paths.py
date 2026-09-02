"""Finding the built frontend.

The hosted deployment is told where it is (GAMMA_STATIC_DIR, set by the
Dockerfile). A packaged desktop app has to work it out, because the path
differs between running from a source checkout and running from inside
Gamma.app/Contents/Resources.
"""

import mimetypes
import os
import sys
from pathlib import Path

# Content types for everything the built frontend serves.
#
# Windows resolves extension → type through the registry, where `.mjs` is
# usually absent, so Python's mimetypes answers text/plain and Chromium
# refuses to execute the file as a module script ("Strict MIME type checking
# is enforced for module scripts"). In the desktop app that silently
# downgraded pdf.js to its main-thread fake worker: pages still rendered, but
# no text was extracted, so selection, highlighting and in-PDF search stopped
# working. Registering these makes every platform answer the same way.
WEB_MIME_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".map": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
}


def register_web_mime_types() -> None:
    """Pin the content types the frontend depends on, whatever the OS thinks."""
    for ext, ctype in WEB_MIME_TYPES.items():
        mimetypes.add_type(ctype, ext)


def candidate_static_dirs() -> list[Path]:
    """Where a built frontend might be, most specific first."""
    here = Path(__file__).resolve()
    backend = here.parent.parent          # …/backend
    repo = backend.parent                 # …/pdf-share

    out = []
    env = os.environ.get("GAMMA_STATIC_DIR", "").strip()
    if env:
        out.append(Path(env))

    # Packaged app: the launcher runs from Resources/, with static/ beside it.
    exe_dir = Path(getattr(sys, "_MEIPASS", "") or Path(sys.executable).resolve().parent)
    out += [
        exe_dir / "static",
        exe_dir.parent / "static",           # …/Resources/python/bin → Resources/static
        exe_dir.parent.parent / "static",
    ]

    # Source checkout.
    out += [repo / "frontend" / "dist", backend / "static"]
    return out


def resolve_static_dir() -> Path | None:
    """The first candidate that actually holds a built frontend, or None.

    "Holds a built frontend" means an index.html exists — an empty or
    half-copied directory must not win, or the app serves a blank page and
    every /api call 404s into the SPA fallback.
    """
    for c in candidate_static_dirs():
        try:
            if c and (c / "index.html").is_file():
                return c.resolve()
        except OSError:
            continue
    return None
