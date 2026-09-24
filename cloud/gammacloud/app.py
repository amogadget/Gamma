"""Assembly: the FastAPI app, security headers, the same-origin check, the
startup upgrade, the hourly purge of expired rows."""

import asyncio
import sqlite3
from contextlib import asynccontextmanager, closing
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import config, db, identities, oidc, sessions
from .accounts import Problem
from .log import log
from .routers import accounts as accounts_router
from .routers import admin as admin_router
from .routers import external as external_router
from .routers import oidc as oidc_router
from .routers import portal as portal_router


def purge() -> None:
    with closing(db.connect()) as conn:
        oidc.purge_expired(conn)
        sessions.purge_stale(conn)
        identities.purge_expired(conn)
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


# The OAuth endpoints a Gamma server calls with its own credentials: no
# cookie is involved, so they take any origin.
_CROSS_ORIGIN_OK = {"/token", "/revoke"}


def same_origin(request: Request) -> bool:
    """Whether a state-changing request comes from this site's own pages.
    The SameSite=Lax cookie alone does not tell account.gammapdf.com from a
    sibling *.gammapdf.com page (a Gamma container), and a POST without a
    JSON body needs no CORS preflight. Browsers send ``Sec-Fetch-Site``;
    older ones an ``Origin``; a request with neither is not from a browser
    and carries no ambient cookie to abuse."""
    site = request.headers.get("sec-fetch-site")
    if site is not None:
        return site in ("same-origin", "none")
    origin = request.headers.get("origin")
    public = urlsplit(config.PUBLIC_URL)
    return origin is None or origin == f"{public.scheme}://{public.netloc}"


def create_app() -> FastAPI:
    app = FastAPI(title="Gamma Cloud accounts", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def same_origin_only(request: Request, call_next):
        if (request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path not in _CROSS_ORIGIN_OK
                and not same_origin(request)):
            return JSONResponse({"detail": "This request must come from the Gamma Cloud pages."}, status_code=403)
        return await call_next(request)

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

    @app.exception_handler(sqlite3.OperationalError)
    async def busy_handler(request: Request, e: sqlite3.OperationalError):
        """Another request held the write lock past db.BUSY_TIMEOUT: a retry
        will do, so a 503 rather than a stack trace."""
        if not db.is_busy(e):
            raise e
        log.warning("cloud.db busy: %s %s", request.method, request.url.path)
        return JSONResponse({"detail": "The server is busy. Try again in a moment."}, status_code=503,
                            headers={"Retry-After": "5"})

    app.include_router(oidc_router.router)
    app.include_router(accounts_router.router)
    app.include_router(admin_router.router)
    app.include_router(external_router.router)
    app.include_router(portal_router.router)
    return app
