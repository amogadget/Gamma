"""FastAPI application assembly: middleware, routers, startup maintenance, SPA serving."""

import sqlite3
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from . import config
from .auth import session_middleware
from .db import DATA_SCHEMA, connect_users_db
from .logbuf import log, setup_logging
from .routers import (
    admin,
    ai,
    auth as auth_router,
    blocks,
    chats,
    export,
    imports,
    links,
    metadata,
    pageimage,
    pdf,
    prefs,
    search,
    shares,
    uploads,
)
from .seed import ensure_admin_seed
from .storage import cleanup_orphan_uploads


def _silence_windows_connection_reset():
    """Swallow the benign ConnectionResetError [WinError 10054] that the Windows
    Proactor event loop raises in _call_connection_lost when a client aborts an
    in-flight stream (e.g. a browser refresh cancelling a 206 range request for a
    PDF). The request has already completed; only the socket teardown fails, and
    stock asyncio logs it as an alarming unhandled-callback traceback.
    See https://github.com/python/cpython/issues/87643."""
    if sys.platform != "win32":
        return
    from asyncio.proactor_events import _ProactorBasePipeTransport

    _orig = _ProactorBasePipeTransport._call_connection_lost

    def _quiet_call_connection_lost(self, exc):
        try:
            _orig(self, exc)
        except (ConnectionResetError, ConnectionAbortedError):
            pass

    _ProactorBasePipeTransport._call_connection_lost = _quiet_call_connection_lost


def _startup_maintenance():
    """Ensure users.db exists, seed a fresh instance's first admin, prune
    orphaned uploads, and apply lightweight schema upgrades to every per-user
    data.db (e.g. the chats table)."""
    connect_users_db().close()
    ensure_admin_seed()
    if not config.USERS_DIR.exists():
        return
    for user_dir in config.USERS_DIR.iterdir():
        if not user_dir.is_dir():
            continue
        uploads_dir = user_dir / "uploads"
        pages_db = user_dir / "pages.db"
        if uploads_dir.exists() and pages_db.exists():
            with sqlite3.connect(str(pages_db)) as conn:
                removed = cleanup_orphan_uploads(conn, uploads_dir)
                if removed:
                    log.info(f"[startup] removed orphan uploads for {user_dir.name}: {removed}")
        data_db = user_dir / "data.db"
        if data_db.exists():
            with sqlite3.connect(str(data_db)) as conn:
                for stmt in DATA_SCHEMA:
                    conn.execute(stmt)
                conn.commit()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Startup maintenance + background model-catalog refresher, run for the
    server's lifetime — not at import time, so importing gamma.app (tests,
    tooling) has no data-directory side effects."""
    _startup_maintenance()
    ai.start_model_catalog_watcher()
    yield


def create_app() -> FastAPI:
    setup_logging()
    _silence_windows_connection_reset()
    app = FastAPI(title="Gamma PDF Annotator", lifespan=lifespan)

    app.middleware("http")(session_middleware)

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    app.include_router(auth_router.router)
    app.include_router(admin.router)
    app.include_router(ai.router)
    app.include_router(chats.router)
    app.include_router(prefs.router)
    app.include_router(metadata.router)
    app.include_router(search.router)
    app.include_router(shares.router)
    app.include_router(pdf.router)
    app.include_router(uploads.router)
    app.include_router(pageimage.router)
    app.include_router(blocks.router)
    app.include_router(imports.router)
    app.include_router(export.router)
    app.include_router(links.router)

    # Serve the built frontend (SPA) when GAMMA_STATIC_DIR is set.
    # Registered last so all /api routes take precedence.
    static_dir = Path(config.STATIC_DIR) if config.STATIC_DIR else None
    if static_dir and static_dir.is_dir():
        index_html = static_dir / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            candidate = (static_dir / path).resolve()
            # Path-traversal guard: only serve files inside the static dir
            if path and candidate.is_file() and candidate.is_relative_to(static_dir.resolve()):
                if path.startswith("assets/"):
                    # Vite content-hashes these filenames — safe to cache forever.
                    return FileResponse(candidate, headers={"Cache-Control": "public, max-age=31536000, immutable"})
                # Unhashed files (pdf.worker.min.mjs, favicons…) change in place on
                # upgrade — always revalidate (cheap 304 via the ETag).
                return FileResponse(candidate, headers={"Cache-Control": "no-cache"})
            # index.html must revalidate every load, or clients keep referencing
            # deleted hashed assets after a deploy.
            return FileResponse(index_html, headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
