"""Load the optional MCP SDK on first use, with a lifespan-owned transport."""

from contextlib import asynccontextmanager

import anyio
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .integrations import resolve_token
from .mcp_oauth import public_base


def _load_server():
    from .mcp_server import GammaMCP

    return GammaMCP()


class LazyMCP:
    @asynccontextmanager
    async def lifespan(self, app):
        # Keep locks and transport state scoped to this run, including when a
        # TestClient opens the same application in multiple event loops.
        async with anyio.create_task_group() as tasks:
            runtime = _Runtime(app, tasks)
            try:
                yield {"gamma_mcp_runtime": runtime}
            finally:
                tasks.cancel_scope.cancel()

    async def __call__(self, scope, receive, send):
        if not await _authorize(scope, receive, send):
            return
        runtime = scope.get("state", {}).get("gamma_mcp_runtime")
        if runtime is None:
            await JSONResponse({"detail": "MCP is starting."}, status_code=503)(scope, receive, send)
            return
        await runtime.ensure_started()
        scope["state"].update(runtime.state)
        await runtime.server(scope, receive, send)

    def route(self):
        return Route("/mcp", self, methods=["GET", "POST", "DELETE"])


class _Runtime:
    def __init__(self, app, tasks):
        self.app = app
        self.tasks = tasks
        self.lock = anyio.Lock()
        self.server = None
        self.state = None

    async def ensure_started(self):
        async with self.lock:
            if self.state is None:
                server = await run_in_threadpool(_load_server)
                await self.tasks.start(self._run, server)

    async def _run(self, server, *, task_status=anyio.TASK_STATUS_IGNORED):
        # Enter and exit the SDK's task group in the same task. Requests only
        # wait for readiness; cancellation of one request cannot stop MCP.
        async with server.lifespan(self.app) as state:
            self.server = server
            self.state = state
            task_status.started()
            await anyio.sleep_forever()


async def _authorize(scope, receive, send):
    request = Request(scope, receive)
    # Native MCP clients do not need browser origins; reject them rather than
    # exposing this token-authenticated endpoint to arbitrary websites.
    if request.headers.get("origin"):
        await JSONResponse({"detail": "Browser origins are not supported."}, status_code=403)(scope, receive, send)
        return False
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    try:
        base = public_base(request)
    except HTTPException:
        base = None  # Manual tokens still support existing HTTP LAN setups.
    resource = base + "/mcp" if base else None
    identity = await run_in_threadpool(resolve_token, token, resource) if scheme.lower() == "bearer" else None
    if identity is None:
        await JSONResponse({"detail": "A valid Gamma integration token is required."}, status_code=401,
                           headers={"WWW-Authenticate": (
                               f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp", scope="gamma:read"'
                               if base else "Bearer"), "Cache-Control": "no-store"})(scope, receive, send)
        return False
    request.state.gamma_integration = identity
    # Use the same canonical origin for picker and read-tool citations.
    # Manual tokens still support HTTP LAN addresses without an OAuth issuer.
    request.state.gamma_base = base or str(request.base_url).rstrip("/")
    return True
