"""SDK-dependent OAuth provider, imported only during assistant sign-in."""
import re
import secrets
import time
from urllib.parse import urlencode

from fastapi import HTTPException
from mcp.server.auth.provider import AuthorizationCode, AuthorizationParams, AuthorizeError, TokenError
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from . import workspaces
from .db import connect_users_db
from .integrations import create_token, token_digest
from .mcp_oauth import SCOPE, TTL, load, store


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
