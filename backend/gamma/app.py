"""FastAPI application assembly: middleware, routers, startup maintenance, SPA serving."""

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from . import config, migrations
from .auth import session_middleware
from .db import connect_data_db, connect_pages_db, connect_users_db
from .logbuf import log, setup_logging
from .routers import (
    admin,
    ai,
    auth as auth_router,
    blocks,
    chats,
    clip,
    collab,
    export,
    imports,
    links,
    metadata,
    pages,
    pdf,
    prefs,
    search,
    shares,
    uploads,
    workspaces,
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
    """In this order: bring the data directory to the current schema version
    (gamma/migrations.py — refuses to serve a newer or unmigratable data
    directory), create users.db on a fresh install, seed the first admin,
    then per workspace: prune orphaned uploads and apply the per-file
    schema statements (a restored backup gains page_ops, WAL, ...)."""
    try:
        done = migrations.ensure_current()
    except migrations.MigrationError as e:
        print(f"[startup] {e}")
        raise SystemExit(1)
    if done["applied"]:
        log.info(f"[startup] data directory upgraded from schema version {done['from']} "
                 f"to {done['to']} ({', '.join(done['applied'])}); snapshot: {done['backup']}")
    connect_users_db().close()
    ensure_admin_seed()
    if not config.WORKSPACES_DIR.exists():
        return
    for ws_root in config.WORKSPACES_DIR.iterdir():
        if not ws_root.is_dir():
            continue
        ws_id = ws_root.name
        uploads_dir = ws_root / "uploads"
        pages_db = ws_root / "pages.db"
        if uploads_dir.exists() and pages_db.exists():
            # connect_pages_db also switches the file to WAL and adds the
            # page_ops table on files that predate them.
            with connect_pages_db(ws_id) as conn:
                removed = cleanup_orphan_uploads(conn, uploads_dir)
                if removed:
                    log.info(f"[startup] removed orphan uploads in workspace {ws_id}: {removed}")
        if (ws_root / "data.db").exists():
            connect_data_db(ws_id).close()


def create_app() -> FastAPI:
    setup_logging()
    _silence_windows_connection_reset()
    app = FastAPI(title="Gamma PDF Annotator")

    app.middleware("http")(session_middleware)

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    app.include_router(auth_router.router)
    app.include_router(admin.router)
    app.include_router(workspaces.router)
    app.include_router(ai.router)
    app.include_router(chats.router)
    app.include_router(chats.history_router)
    app.include_router(prefs.router)
    app.include_router(metadata.router)
    app.include_router(search.router)
    app.include_router(shares.router)
    app.include_router(pdf.router)
    app.include_router(uploads.router)
    app.include_router(blocks.router)
    app.include_router(pages.router)
    app.include_router(imports.router)
    app.include_router(export.router)
    app.include_router(links.router)
    app.include_router(clip.router)
    app.include_router(collab.router)

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

    _startup_maintenance()
    return app


app = create_app()
