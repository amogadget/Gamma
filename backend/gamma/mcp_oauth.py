"""Browser consent for MCP clients, using the SDK's OAuth/PKCE handlers.

Clients use dynamic registration, S256 authorization codes and opaque,
revocable 90-day tokens. No refresh tokens or third-party identity service.
"""
import json
import re
import secrets
import time
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from mcp.server.auth.handlers.authorize import AuthorizationHandler
from mcp.server.auth.handlers.token import TokenHandler
from mcp.server.auth.middleware.client_auth import ClientAuthenticator
from mcp.server.auth.provider import AuthorizationCode, AuthorizationParams, AuthorizeError, TokenError, construct_redirect_uri
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken
from pydantic import BaseModel, Field, ValidationError

from . import ratelimit, workspaces
from .auth import SESSION_COOKIE, require_user
from .db import connect_users_db
from .integrations import create_token, token_digest
from .server_settings import public_url_settings, mcp_allowed_hosts

router = APIRouter()
SCOPE = "gamma:read"
TTL = 90 * 86400


def public_base(request: Request) -> str:
    """Never advertise an issuer from an arbitrary, untrusted Host header."""
    configured = public_url_settings()["public_url"]
    base = configured or str(request.base_url).rstrip("/")
    url = urlsplit(base)
    allowed = set(mcp_allowed_hosts(configured))
    local = url.hostname in {"localhost", "127.0.0.1", "::1"}
    if (url.scheme not in {"https", "http"} or url.username or url.password or url.query or url.fragment
            or (url.scheme == "http" and not local)):
        raise HTTPException(400, "MCP browser sign-in requires HTTPS, or localhost for local use.")
    if url.path not in ("", "/"):
        raise HTTPException(400, "MCP browser sign-in requires Gamma at the origin root, without a URL path prefix.")
    if not local and url.netloc.lower() not in allowed:
        raise HTTPException(421, "Confirm the public server URL in Settings > Administration > Server first.")
    # Even with a configured canonical issuer, reject requests routed via an
    # unexpected Host. Local reverse proxies should preserve the external Host.
    if request.url.netloc.lower() != url.netloc.lower():
        raise HTTPException(421, "Use Gamma's configured public URL for MCP sign-in.")
    return base


def _key(base, identifier):
    return token_digest(base + "\0" + identifier)


def store(kind, base, identifier, value, seconds):
    with connect_users_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM mcp_oauth WHERE expires_at <= ?", (int(time.time()),))
        if conn.execute("SELECT COUNT(*) FROM mcp_oauth WHERE kind = ?", (kind,)).fetchone()[0] >= 2000:
            raise HTTPException(429, "Too many pending connections. Try again later.")
        conn.execute("INSERT INTO mcp_oauth VALUES (?, ?, ?, ?)",
                     (kind, _key(base, identifier), json.dumps(value), int(time.time()) + seconds))


def load(kind, base, identifier, *, consume=False):
    with connect_users_db() as conn:
        if consume:
            conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT value FROM mcp_oauth WHERE kind = ? AND key_hash = ? AND expires_at > ?",
                           (kind, _key(base, identifier), int(time.time()))).fetchone()
        if consume and row:
            conn.execute("DELETE FROM mcp_oauth WHERE kind = ? AND key_hash = ?", (kind, _key(base, identifier)))
    return json.loads(row[0]) if row else None


class GammaCode(AuthorizationCode):
    username: str
    workspace_id: str
    session_hash: str


class Provider:
    def __init__(self, base):
        self.base = base
        self.resource = base + "/mcp"

    async def get_client(self, client_id):
        value = load("client", self.base, client_id)
        return OAuthClientInformationFull.model_validate(value) if value else None

    async def authorize(self, client, params: AuthorizationParams):
        if params.resource != self.resource:
            raise AuthorizeError("invalid_request", "The resource must be this Gamma MCP URL.")
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", params.code_challenge):
            raise AuthorizeError("invalid_request", "A valid S256 PKCE challenge is required.")
        if params.scopes is not None and params.scopes != [SCOPE]:
            raise AuthorizeError("invalid_scope", "Only gamma:read is supported.")
        request_id = secrets.token_urlsafe(32)
        store("request", self.base, request_id,
              {"client_id": client.client_id, "params": params.model_dump(mode="json")}, 600)
        return self.base + "/?" + urlencode({"gamma_oauth": request_id})

    async def load_authorization_code(self, client, authorization_code):
        value = load("code", self.base, authorization_code)
        return GammaCode(code=authorization_code, **value) if value else None

    async def exchange_authorization_code(self, client, authorization_code: GammaCode):
        # Atomic consumption prevents parallel exchanges of a valid code.
        value = load("code", self.base, authorization_code.code, consume=True)
        if not value or value["client_id"] != client.client_id or value["resource"] != self.resource:
            raise TokenError("invalid_grant", "The authorization code is no longer valid.")
        with connect_users_db() as conn:
            user = conn.execute("SELECT is_guest FROM users WHERE username = ?", (value["username"],)).fetchone()
            sessions = conn.execute("SELECT token FROM sessions WHERE username = ?", (value["username"],)).fetchall()
        if (not user or user[0] or not any(token_digest(s[0]) == value["session_hash"] for s in sessions)
                or not workspaces.role_of(value["workspace_id"], value["username"])):
            raise TokenError("invalid_grant", "Workspace access is no longer available.")
        try:
            issued = create_token(value["username"], value["workspace_id"],
                                  (client.client_name or "MCP assistant")[:65] + " (OAuth)", 90,
                                  oauth_resource=self.resource)
        except HTTPException as exc:
            raise TokenError("invalid_grant", str(exc.detail)) from exc
        return OAuthToken(access_token=issued["token"], expires_in=TTL, scope=SCOPE)

    async def load_refresh_token(self, client, refresh_token):
        return None


def _no_store(value, status=200):
    return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


@router.get("/.well-known/oauth-protected-resource/mcp")
@router.get("/.well-known/oauth-protected-resource")
def resource_metadata(request: Request):
    base = public_base(request)
    return {"resource": base + "/mcp", "authorization_servers": [base],
            "scopes_supported": [SCOPE], "bearer_methods_supported": ["header"], "resource_name": "Gamma PDF"}


@router.get("/.well-known/oauth-authorization-server")
def authorization_metadata(request: Request):
    base = public_base(request)
    return {"issuer": base, "authorization_endpoint": base + "/oauth/authorize",
            "token_endpoint": base + "/oauth/token", "registration_endpoint": base + "/oauth/register",
            "response_types_supported": ["code"], "grant_types_supported": ["authorization_code"],
            "token_endpoint_auth_methods_supported": ["none"], "code_challenge_methods_supported": ["S256"],
            "scopes_supported": [SCOPE]}


async def body(request):
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > 16384:
            raise HTTPException(413, "OAuth request is too large.")
        chunks.append(chunk)
    request._body = b"".join(chunks)


@router.post("/oauth/register")
async def register(request: Request):
    base = public_base(request)
    ratelimit.check("mcp-register:" + ratelimit.client_ip(request), 30, 3600)
    await body(request)
    try:
        metadata = OAuthClientMetadata.model_validate(await request.json())
        if metadata.token_endpoint_auth_method not in (None, "none") or not metadata.redirect_uris or len(metadata.redirect_uris) > 10:
            raise ValueError("Use a public client with token_endpoint_auth_method none.")
        for uri in metadata.redirect_uris:
            url = urlsplit(str(uri))
            if (url.username or url.password or url.fragment or not url.hostname or
                    (url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"}))):
                return _no_store({"error": "invalid_redirect_uri"}, 400)
        if (metadata.scope not in (None, SCOPE) or "authorization_code" not in metadata.grant_types
                or metadata.response_types != ["code"] or len(metadata.client_name or "") > 100):
            raise ValueError("Only the read-only authorization code flow is supported.")
    except (ValidationError, ValueError, json.JSONDecodeError):
        return _no_store({"error": "invalid_client_metadata"}, 400)
    client = OAuthClientInformationFull(**{**metadata.model_dump(), "token_endpoint_auth_method": "none",
                                          "scope": SCOPE, "grant_types": ["authorization_code"]},
                                      client_id=secrets.token_urlsafe(24), client_id_issued_at=int(time.time()))
    store("client", base, client.client_id, client.model_dump(mode="json"), TTL)
    return _no_store(client.model_dump(mode="json", exclude_none=True), 201)


@router.get("/oauth/authorize")
async def authorize(request: Request):
    base = public_base(request)
    ratelimit.check("mcp-authorize:" + ratelimit.client_ip(request), 60, 600)
    if len(str(request.url)) > 8192:
        raise HTTPException(414)
    result = await AuthorizationHandler(Provider(base)).handle(request)
    result.headers["Cache-Control"] = "no-store"
    return result


@router.post("/oauth/token")
async def token(request: Request):
    base = public_base(request)
    ratelimit.check("mcp-token:" + ratelimit.client_ip(request), 120, 600)
    await body(request)
    form = await request.form()
    if form.get("resource") != base + "/mcp":
        return _no_store({"error": "invalid_target"}, 400)
    if not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", str(form.get("code_verifier", ""))):
        return _no_store({"error": "invalid_request"}, 400)
    provider = Provider(base)
    return await TokenHandler(provider, ClientAuthenticator(provider)).handle(request)


def consent_user(request):
    user = require_user(request)
    if request.state.is_guest:
        raise HTTPException(403, "Sign in with a personal account to connect an assistant.")
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != f"{request.url.scheme}://{request.url.netloc}":
        raise HTTPException(403, "Cross-origin consent is not allowed.")
    return user


@router.get("/api/integrations/oauth/request")
async def consent_details(request: Request, request_id: str):
    base, user = public_base(request), consent_user(request)
    pending = load("request", base, request_id)
    client = await Provider(base).get_client(pending["client_id"]) if pending else None
    if not pending or not client:
        raise HTTPException(400, "This sign-in request expired. Start connecting again from your assistant.")
    csrf = secrets.token_urlsafe(32)
    store("consent", base, csrf, {"request_id": request_id, "user": user,
                                  "session": token_digest(request.cookies.get(SESSION_COOKIE, ""))}, 600)
    return _no_store({"client_name": client.client_name or "MCP assistant", "username": user,
                      "redirect_uri": pending["params"]["redirect_uri"], "csrf": csrf,
                      "workspaces": workspaces.list_for_user(user), "default_workspace": request.state.default_ws})


class Consent(BaseModel):
    request_id: str = Field(max_length=128)
    csrf: str = Field(max_length=128)
    workspace_id: str = Field(default="", max_length=64)
    approve: bool


@router.post("/api/integrations/oauth/consent")
async def consent(payload: Consent, request: Request):
    base, user = public_base(request), consent_user(request)
    binding = load("consent", base, payload.csrf)
    if (not binding or binding["request_id"] != payload.request_id or binding["user"] != user or
            binding["session"] != token_digest(request.cookies.get(SESSION_COOKIE, ""))):
        raise HTTPException(403, "Consent expired or the signed-in account changed. Start again.")
    if payload.approve and not workspaces.role_of(payload.workspace_id, user):
        raise HTTPException(403, "You cannot connect this workspace.")
    pending = load("request", base, payload.request_id, consume=True)
    load("consent", base, payload.csrf, consume=True)
    if not pending:
        raise HTTPException(400, "This sign-in request has already been used or expired.")
    params = AuthorizationParams.model_validate(pending["params"])
    if not payload.approve:
        return _no_store({"redirect_url": construct_redirect_uri(str(params.redirect_uri), error="access_denied", state=params.state)})
    code = secrets.token_urlsafe(32)
    value = GammaCode(code=code, client_id=pending["client_id"], username=user, workspace_id=payload.workspace_id,
                      session_hash=binding["session"],
                      scopes=[SCOPE], expires_at=time.time() + 120, code_challenge=params.code_challenge,
                      redirect_uri=params.redirect_uri, redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
                      resource=params.resource, subject=user)
    store("code", base, code, value.model_dump(mode="json", exclude={"code"}), 120)
    return _no_store({"redirect_url": construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state)})
