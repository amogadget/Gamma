"""Full Gamma, embedded in a native-owned CPython worker thread.

Native contract::

    serve(RuntimeConfig(app_support / 'Gamma', bundle / 'dist'), ready, stop_event)

``serve`` blocks until a threading.Event is set; it owns an asyncio loop, not
CPython, and never finalizes the interpreter. ``ready(BootstrapResult)`` runs on
that worker only AFTER lifespan startup, account/session creation and an HTTP
health probe. Marshal the result directly to the trusted native caller, NEVER
logs, URLs, JavaScript or preferences. Install BOTH returned cookies in the
WKWebsiteDataStore before navigation. Cookies are host-only (127.0.0.1), Path=/,
HttpOnly, SameSite=Strict, session-only; HTTP loopback cannot use Secure cookies.
Cookies have no port scope: use a dedicated nonpersistent WK data store, reject
navigation to other origins/ports in native code, and clear cookies on stop.
The random cookie name/value changes every launch; native HTTP clients may use
X-Gamma-Local-Capability instead. WebSockets use the capability cookie.

Package backend/ on sys.path before calling; all backend dependencies and the
actual frontend dist must be bundled. Missing dependencies are fatal, never
stubbed. Only one embedded server may run per interpreter; later starts must
use the SAME paths (Gamma configuration and services are process globals).
Uvicorn/lifespan and the issued session are stopped/revoked on return. Gamma's
existing daemon mirror scheduler is process-owned and remains alive until
interpreter/process exit; it is not disabled or duplicated on restart.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.cookies import SimpleCookie, CookieError
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import threading
from typing import Callable
import urllib.request


@dataclass(frozen=True)
class RuntimeConfig:
    data_dir: Path
    static_dir: Path
    shutdown_timeout: float = 10.0


@dataclass(frozen=True)
class LocalCookie:
    name: str
    value: str = field(repr=False)
    domain: str = '127.0.0.1'
    path: str = '/'
    http_only: bool = True
    same_site: str = 'Strict'
    secure: bool = False
    host_only: bool = True

    def header(self) -> str:
        return f'{self.name}={self.value}'


@dataclass(frozen=True)
class BootstrapResult:
    url: str
    account: str
    workspace: str
    session_cookie: LocalCookie = field(repr=False)
    capability_cookie: LocalCookie = field(repr=False)
    capability_header: str = 'X-Gamma-Local-Capability'

    @property
    def capability(self) -> str:
        return self.capability_cookie.value


_lock = threading.Lock()
_paths: tuple[Path, Path] | None = None
_app = None
_identity: str | None = None


def _prepare(config: RuntimeConfig):
    global _paths, _app, _identity
    data, static = Path(config.data_dir).resolve(), Path(config.static_dir).resolve()
    if not (static / 'index.html').is_file():
        raise ValueError('Bundled Gamma dist/index.html is required')
    if data == static or data in static.parents or static in data.parents:
        raise ValueError('Private data and bundled static directories must be separate')
    if config.shutdown_timeout <= 0:
        raise ValueError('shutdown_timeout must be positive')
    if _paths is not None:
        if _paths != (data, static) or _app is None:
            raise RuntimeError('This interpreter already configured Gamma; restart the interpreter')
        return _app, _identity
    if any(name == 'gamma' or name.startswith('gamma.') for name in sys.modules):
        raise RuntimeError('Configure the embedded runtime BEFORE importing Gamma')
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    marker = data / '.gamma-ios-identity.json'
    if marker.exists():
        identity = json.loads(marker.read_text(encoding='utf-8'))['account']
        if not isinstance(identity, str) or not identity.startswith('gamma-local-') or len(identity) != 36:
            raise RuntimeError('Invalid embedded identity marker')
    else:
        if any(data.iterdir()):
            raise RuntimeError('Refusing an unowned, nonempty data directory')
        identity = 'gamma-local-' + secrets.token_hex(12)
        # Only an account identifier persists, never a password or capability.
        with marker.open('x', encoding='utf-8') as out:
            os.chmod(marker, 0o600)
            json.dump({'account': identity}, out)
    os.environ['GAMMA_DATA_DIR'] = str(data)
    os.environ['GAMMA_STATIC_DIR'] = str(static)
    old_seed = {key: os.environ.get(key) for key in ('GAMMA_ADMIN_USER', 'GAMMA_ADMIN_PASSWORD')}
    os.environ['GAMMA_ADMIN_USER'] = identity
    os.environ['GAMMA_ADMIN_PASSWORD'] = secrets.token_urlsafe(48)
    _paths = (data, static)
    try:
        # The SAME first-run seed, migrations, maintenance, routes and services
        # as desktop. Explicit password makes seed output redact its value.
        from gamma.app import app
        _app, _identity = app, identity
    finally:
        for key, value in old_seed.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    return _app, _identity


def _session(account: str) -> tuple[str, str]:
    from gamma.db import connect_users_db, page_now
    from gamma import workspaces
    with connect_users_db() as db:
        row = db.execute('SELECT is_admin, is_guest, default_workspace FROM users WHERE username=?',
                         (account,)).fetchone()
        if not row or not row[0] or row[1] or not row[2]:
            raise RuntimeError('Embedded owner account is missing or invalid')
        workspace = row[2]
        if workspaces.role_of(workspace, account) != 'owner':
            raise RuntimeError('Embedded owner workspace is invalid')
        token = secrets.token_urlsafe(32)
        # Exact same session-row contract as gamma.routers.auth.login; this
        # trusted native entry is NOT an HTTP authentication bypass endpoint.
        db.execute('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)',
                   (token, account, page_now()))
        db.commit()
    return token, workspace


class _LocalGate:
    """Outermost ASGI gate: includes static, docs, auth, MCP and WebSockets."""
    def __init__(self, app, authority: str, cookie: LocalCookie):
        self.app, self.authority, self.cookie = app, authority, cookie
        self.ready = False

    async def __call__(self, scope, receive, send):
        if scope['type'] not in ('http', 'websocket'):
            return await self.app(scope, receive, send)
        headers = {}
        for key, value in scope.get('headers', []):
            headers.setdefault(key.lower(), []).append(value.decode('latin1'))
        host = headers.get(b'host', [])
        origin = headers.get(b'origin', [])
        caps = headers.get(b'x-gamma-local-capability', [])
        cookie_values = []
        try:
            for raw in headers.get(b'cookie', []):
                cookies = SimpleCookie()
                cookies.load(raw)
                if self.cookie.name in cookies:
                    cookie_values.append(cookies[self.cookie.name].value)
        except CookieError:
            cookie_values = []
        valid_cap = (len(caps) == 1 and secrets.compare_digest(caps[0].encode('latin1'), self.cookie.value.encode('ascii'))) or (
            len(cookie_values) == 1 and secrets.compare_digest(cookie_values[0].encode('latin1'), self.cookie.value.encode('ascii')))
        allowed = (self.ready and host == [self.authority] and
                   (not origin or origin == ['http://' + self.authority]) and valid_cap)
        if not allowed:
            if scope['type'] == 'websocket':
                await send({'type': 'websocket.close', 'code': 1008})
            else:
                await send({'type': 'http.response.start', 'status': 403,
                            'headers': [(b'content-type', b'text/plain'), (b'cache-control', b'no-store')]})
                await send({'type': 'http.response.body', 'body': b'Forbidden'})
            return
        await self.app(scope, receive, send)


def health_probe(result: BootstrapResult) -> bool:
    """Native-side stdlib probe, with proxies disabled and no credential URL."""
    request = urllib.request.Request(result.url + '/api/health', headers={
        result.capability_header: result.capability,
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=5) as response:
        return response.status == 200 and json.load(response).get('ok') is True


def serve(config: RuntimeConfig, ready_callback: Callable[[BootstrapResult], None],
          stop_event: threading.Event) -> None:
    """Blocking worker-thread entry. Exceptions propagate; readiness is once/run.

    The callback must return promptly; set stop_event from any native thread.
    Startup failures never call ready_callback. No signals, child processes,
    reload, uvloop, interpreter teardown, or remote bind are used.
    """
    if not _lock.acquire(blocking=False):
        raise RuntimeError('An embedded Gamma runtime is already active')
    try:
        app, account = _prepare(config)
        asyncio.run(_serve(app, account, config, ready_callback, stop_event))
    finally:
        _lock.release()


async def _serve(app, account, config, ready_callback, stop_event):
    import uvicorn
    from gamma.db import connect_users_db

    class WorkerServer(uvicorn.Server):
        @contextmanager
        def capture_signals(self):
            yield

        def install_signal_handlers(self):  # older uvicorn; no platform signal calls
            pass

    token = None
    server = None
    task = None
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        sock.setblocking(False)
        authority = f'127.0.0.1:{sock.getsockname()[1]}'
        cookie = LocalCookie('gamma_local_' + secrets.token_hex(12), secrets.token_urlsafe(32))
        gate = _LocalGate(app, authority, cookie)
        server = WorkerServer(uvicorn.Config(
            gate, host='127.0.0.1', port=0, loop='asyncio', http='h11', ws='websockets',
            lifespan='on', workers=1, reload=False, proxy_headers=False,
            access_log=False, log_config=None, timeout_graceful_shutdown=config.shutdown_timeout,
        ))
        try:
            task = asyncio.create_task(server.serve(sockets=[sock]))
            while not server.started:
                if task.done():
                    await task
                    raise RuntimeError('Gamma lifespan failed before readiness')
                await asyncio.sleep(0.01)
            token, workspace = _session(account)
            result = BootstrapResult('http://' + authority, account, workspace,
                                     LocalCookie('session', token), cookie)
            gate.ready = True
            if not await asyncio.to_thread(health_probe, result):
                raise RuntimeError('Gamma readiness probe failed')
            if not stop_event.is_set():
                ready_callback(result)
            while not stop_event.is_set():
                if task.done():
                    await task
                    raise RuntimeError('Gamma stopped unexpectedly')
                await asyncio.sleep(0.05)
        finally:
            gate.ready = False
            server.should_exit = True
            try:
                if task is not None:
                    await task
            finally:
                if token is not None:
                    with connect_users_db() as db:
                        db.execute('DELETE FROM sessions WHERE token=?', (token,))
                        db.commit()
