"""Assembly: the FastAPI app, security headers, the startup upgrade, the
hourly purge of expired rows."""

import asyncio
from contextlib import asynccontextmanager, closing

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import config, db, oidc, sessions
from .accounts import Problem
from .log import log
from .routers import accounts as accounts_router
from .routers import admin as admin_router
from .routers import oidc as oidc_router
from .routers import portal as portal_router


def purge() -> None:
    with closing(db.connect()) as conn:
        oidc.purge_expired(conn)
        sessions.purge_stale(conn)
        conn.commit()


async def _purge_loop():
    while True:
        await asyncio.sleep(3600)
        try:
            await asyncio.to_thread(purge)
        except Exception as e:  # noqa: BLE001 — a purge must never stop the loop
            log.warning("purge failed: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    done = db.ensure_current()
    if done:
        log.info("cloud.db upgraded: %s", ", ".join(done))
    with closing(db.connect()) as conn:
        oidc.ensure_signing_key(conn)
        conn.commit()
    purge()
    task = asyncio.create_task(_purge_loop())
    log.info("account server at %s (registration %s, mail %s)", config.PUBLIC_URL, config.REGISTRATION,
             config.MAIL_BACKEND)
    try:
        yield
    finally:
        task.cancel()


def create_app() -> FastAPI:
    app = FastAPI(title="Gamma Cloud accounts", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        if config.PUBLIC_URL.startswith("https://"):
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
        return response

    @app.exception_handler(Problem)
    async def problem_handler(request: Request, e: Problem):
        return JSONResponse({"detail": e.detail}, status_code=e.status)

    app.include_router(oidc_router.router)
    app.include_router(accounts_router.router)
    app.include_router(admin_router.router)
    app.include_router(portal_router.router)
    return app
