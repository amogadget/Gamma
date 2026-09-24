"""FastAPI application assembly: middleware, routers, startup maintenance, SPA serving."""

import mimetypes
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response

from . import backup_schedule, config, migrations
from . import sync_engine, version
from .auth import session_middleware
from .db import connect_data_db, connect_pages_db, connect_users_db
from .logbuf import log, setup_logging
from .mcp_lazy import LazyMCP
from .mcp_oauth import router as mcp_oauth_router
from .routers import (
    admin,
    ai,
    auth as auth_router,
    blank_pdf,
    blocks,
    backup_tasks,
    chats,
    clip,
    collab,
    export,
    imports,
    integrations,
    ink,
    links,
    metadata,
    native_highlights,
    native_ink,
    mirrors,
    pages,
    pdf,
    prefs,
    publisher_sessions,
    search,
    shares,
    sync,
    uploads,
    workspaces,
    ws_backups, cloud_auth as cloud_auth_router)
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
    log.info(f"[startup] Gamma {version.label()}")
    try:
        done = migrations.ensure_current()
    except migrations.MigrationError as e:
        log.error(f"[startup] {e}")
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
    mcp = LazyMCP()
    @asynccontextmanager
    async def lifespan(app):
        # The MCP lifespan's yield is request state (its runtime, read by the
        # /mcp route from scope["state"]) — it must pass through here.
        async with mcp.lifespan(app) as state, backup_schedule.lifespan():
            yield state

    app = FastAPI(title="Gamma PDF Annotator", lifespan=lifespan)

    app.middleware("http")(session_middleware)

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    app.include_router(auth_router.router)
    app.include_router(cloud_auth_router.router)
    app.include_router(admin.router)
    app.include_router(workspaces.router)
    app.include_router(ws_backups.router)
    app.include_router(backup_tasks.router)
    app.include_router(ai.router)
    app.include_router(chats.router)
    app.include_router(chats.history_router)
    app.include_router(prefs.router)
    app.include_router(integrations.router)
    app.include_router(mcp_oauth_router)
    app.router.routes.append(mcp.route())
    app.include_router(metadata.router)
    app.include_router(search.router)
    app.include_router(shares.router)
    app.include_router(pdf.router)
    app.include_router(blank_pdf.router)
    app.include_router(publisher_sessions.router)
    app.include_router(uploads.router)
    # Upstream handwriting (POST /api/upload-ink, properties.ink_url), then the
    # native client's own routes: /api/assets and the ink/audio/note writers.
    app.include_router(ink.router)
    app.include_router(native_ink.router)
    app.include_router(native_highlights.router)
    app.include_router(blocks.router)
    app.include_router(pages.router)
    app.include_router(imports.router)
    app.include_router(export.router)
    app.include_router(links.router)
    app.include_router(clip.router)
    app.include_router(collab.router)
    app.include_router(sync.router)
    app.include_router(mirrors.router)

    # Serve the built frontend (SPA) when GAMMA_STATIC_DIR is set.
    # Registered last so all /api routes take precedence.
    static_dir = Path(config.STATIC_DIR) if config.STATIC_DIR else None
    if static_dir and static_dir.is_dir():
        index_html = static_dir / "index.html"
        # The web app manifest (/media/manifest.webmanifest, the "Add to Home
        # Screen" install): FileResponse guesses types from the OS table,
        # which lacks this one on Windows and in slim images.
        mimetypes.add_type("application/manifest+json", ".webmanifest")

        def revalidating(file: Path, request: Request):
            """An unhashed file (index.html, favicons) changes in place on
            upgrade, so it is sent ``no-cache``: the browser asks every time,
            and gets a 304 when it already holds this version. Starlette's
            FileResponse sets an ETag but never compares one, so without this
            every revalidation carried the whole body."""
            st = file.stat()
            etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
            headers = {"Cache-Control": "no-cache", "ETag": etag}
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers=headers)
            return FileResponse(file, headers=headers)

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str, request: Request):
            candidate = (static_dir / path).resolve()
            # Path-traversal guard: only serve files inside the static dir
            if path and candidate.is_file() and candidate.is_relative_to(static_dir.resolve()):
                if path.startswith("assets/"):
                    # Vite content-hashes these filenames (the pdf.js worker
                    # among them) — safe to cache forever.
                    return FileResponse(candidate, headers={"Cache-Control": "public, max-age=31536000, immutable"})
                return revalidating(candidate, request)
            # index.html must revalidate every load, or clients keep referencing
            # deleted hashed assets after a deploy.
            return revalidating(index_html, request)

    _startup_maintenance()

    sync_engine.start_loop()
    return app


app = create_app()
