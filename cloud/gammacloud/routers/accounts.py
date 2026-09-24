"""The account API under ``/api``: register, sign in and out, the account
itself (``/me``), the e-mail links, signed-in devices and browsers. JSON in,
JSON out; every state change must come from the portal's own pages
(``app.same_origin``), which is the CSRF protection.

Where an answer would reveal whether an address has an account (register,
reset request) the response is the same either way and the mail says what
happened. Mail goes out after the commit: a slow mail server must never
hold cloud.db's write lock.
"""

from contextlib import closing

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import accounts, captcha, config, db, mail, oidc, ratelimit, sessions
from ..log import log

router = APIRouter(prefix="/api")


# --- helpers ------------------------------------------------------------------

def current_account(conn, request: Request):
    """The account behind a portal cookie or a bearer access token."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        found = oidc.resolve_access_token(conn, auth[7:].strip())
        if not found:
            raise HTTPException(401, "invalid or expired token")
        request.state.auth = "token"
        return found[0]
    account = sessions.resolve(conn, request)
    if not account:
        raise HTTPException(401, "not signed in")
    request.state.auth = "session"
    return account


def portal_account(conn, request: Request):
    """Like ``current_account`` but only a portal session — for the actions a
    bearer token from a Gamma server must not perform (password, e-mail,
    deletion)."""
    account = sessions.resolve(conn, request)
    if not account:
        raise HTTPException(401, "not signed in")
    return account


def send_mail(to: str, subject: str, body: str, html: str = "") -> None:
    """A mail that cannot be sent is a 503 with a plain message, never a
    stack trace: the provider being down or the domain unverified is an
    operator's problem, logged as a warning."""
    try:
        mail.send(to, subject, body, html)
    except mail.MailError as e:
        log.warning("mail to %s failed: %s", to, e)
        raise HTTPException(503, "We could not send the e-mail right now. Try again in a few minutes.") from e


def verify_message(conn, account) -> tuple[str, str, str, str]:
    """Issue a verify link; the message to ``send_mail`` once the
    transaction has committed."""
    token = accounts.issue_email_token(conn, account["id"], "verify", config.VERIFY_TOKEN_TTL)
    return (account["email"], *accounts.verify_mail(account, token))


# --- config for the pages -----------------------------------------------------

@router.get("/config")
def public_config():
    return {"registration": config.REGISTRATION, "turnstile_sitekey": config.TURNSTILE_SITEKEY,
            "issuer": config.PUBLIC_URL, "plans": list(config.PLANS)}


# --- register / login ---------------------------------------------------------

class RegisterBody(BaseModel):
    email: str
    username: str
    password: str
    invite: str = ""
    display_name: str = ""
    turnstile: str = ""


@router.post("/register")
def register(body: RegisterBody, request: Request):
    if config.REGISTRATION == "closed":
        raise HTTPException(403, "Registration is closed.")
    ip = ratelimit.client_ip(request)
    ratelimit.check(f"register:ip:{ip}", 5, 3600)
    if not captcha.verify(body.turnstile, ip):
        raise HTTPException(400, "The anti-bot check failed. Reload and try again.")
    email = accounts.norm_email(body.email)
    username = accounts.norm_username(body.username)
    password = accounts.check_password(body.password)
    with closing(db.connect()) as conn:
        plan = accounts.take_invite(conn, body.invite)
        account = accounts.create(conn, email=email, username=username, password=password, plan=plan,
                                  display_name=body.display_name)
        message = verify_message(conn, account)
        token = sessions.create(conn, account["id"], request)
        conn.commit()
    # The account exists now: a mail that fails is resent from the Overview.
    try:
        mail.send(*message)
        mailed = True
    except mail.MailError as e:
        log.warning("mail to %s failed: %s", account["email"], e)
        mailed = False
    resp = JSONResponse({"account": accounts.public(account), "mailed": mailed}, status_code=201)
    sessions.set_cookie(resp, token)
    return resp


class LoginBody(BaseModel):
    login: str
    password: str


@router.post("/login")
def login(body: LoginBody, request: Request):
    ip = ratelimit.client_ip(request)
    who = body.login.strip().lower()[:254]
    ratelimit.check(f"login:ip:{ip}", 10, 300)
    ratelimit.check(f"login:who:{who}", 10, 300)
    with closing(db.connect()) as conn:
        account = accounts.by_login(conn, who)
        if not accounts.password_ok(account, body.password):
            raise HTTPException(401, "Wrong e-mail, username or password.")
        token = sessions.create(conn, account["id"], request)
        db.audit(conn, "account.login", account["id"], account["id"], ip)
        conn.commit()
    ratelimit.reset(f"login:ip:{ip}")
    ratelimit.reset(f"login:who:{who}")
    resp = JSONResponse({"account": accounts.public(account)})
    sessions.set_cookie(resp, token)
    return resp


@router.post("/logout")
def logout(request: Request):
    with closing(db.connect()) as conn:
        sessions.drop(conn, request)
        conn.commit()
    resp = JSONResponse({"ok": True})
    sessions.clear_cookie(resp)
    return resp


# --- me -----------------------------------------------------------------------

@router.get("/me")
def me(request: Request):
    """The account, its signed-in devices and (v1) its servers. A Gamma
    sidecar reads this with its access token to learn which servers the
    person has."""
    with closing(db.connect()) as conn:
        account = current_account(conn, request)
        out = {"account": accounts.public(account), "servers": [], "auth": request.state.auth}
        if request.state.auth == "session":
            out["devices"] = oidc.devices(conn, account["id"])
        conn.commit()
    return out


class ProfileBody(BaseModel):
    display_name: str


@router.patch("/me")
def update_me(body: ProfileBody, request: Request):
    with closing(db.connect()) as conn:
        account = portal_account(conn, request)
        accounts.set_display_name(conn, account["id"], body.display_name)
        conn.commit()
        return {"account": accounts.public(accounts.by_id(conn, account["id"]))}


class UsernameBody(BaseModel):
    username: str
    password: str = ""


@router.post("/me/username")
def change_username(body: UsernameBody, request: Request):
    with closing(db.connect()) as conn:
        account = portal_account(conn, request)
        if not accounts.confirm_ok(account, body.password):
            raise HTTPException(403, "The password is wrong.")
        ratelimit.check(f"username-change:{account['id']}", 5, 86400)
        accounts.set_username(conn, account["id"], body.username)
        conn.commit()
        return {"account": accounts.public(accounts.by_id(conn, account["id"]))}


class PasswordBody(BaseModel):
    current: str = ""   # none when the account has no password yet
    new: str


@router.post("/me/password")
def change_password(body: PasswordBody, request: Request):
    with closing(db.connect()) as conn:
        account = portal_account(conn, request)
        if not accounts.confirm_ok(account, body.current):
            raise HTTPException(403, "The current password is wrong.")
        accounts.check_password(body.new)
        accounts.set_password(conn, account["id"], body.new)
        token = sessions.create(conn, account["id"], request)  # this browser stays signed in
        conn.commit()
    resp = JSONResponse({"ok": True})
    sessions.set_cookie(resp, token)
    return resp


class DeleteBody(BaseModel):
    password: str = ""


@router.post("/me/delete")
def delete_me(body: DeleteBody, request: Request):
    with closing(db.connect()) as conn:
        account = portal_account(conn, request)
        if not accounts.confirm_ok(account, body.password):
            raise HTTPException(403, "The password is wrong.")
        accounts.delete(conn, account["id"])
        conn.commit()
    log.info("account %s deleted itself", account["username"])
    resp = JSONResponse({"ok": True})
    sessions.clear_cookie(resp)
    return resp


# --- e-mail verification -------------------------------------------------------

class TokenBody(BaseModel):
    token: str


@router.post("/verify")
def verify(body: TokenBody, request: Request):
    ratelimit.check(f"verify:ip:{ratelimit.client_ip(request)}", 20, 600)
    with closing(db.connect()) as conn:
        found = accounts.consume_email_token(conn, body.token, "verify")
        if not found:
            raise HTTPException(400, "This link is not valid any more. Sign in and ask for a new one.")
        account, _ = found
        accounts.mark_verified(conn, account["id"])
        conn.commit()
        return {"account": accounts.public(accounts.by_id(conn, account["id"]))}


@router.post("/verify/resend")
def resend_verify(request: Request):
    with closing(db.connect()) as conn:
        account = portal_account(conn, request)
        if account["email_verified_at"]:
            return {"ok": True, "already": True}
        ratelimit.check(f"verify-resend:{account['id']}", 3, 3600)
        message = verify_message(conn, account)
        conn.commit()
    send_mail(*message)
    return {"ok": True}


# --- password reset -----------------------------------------------------------

class ResetRequestBody(BaseModel):
    email: str
    turnstile: str = ""


@router.post("/reset/request")
def reset_request(body: ResetRequestBody, request: Request):
    ip = ratelimit.client_ip(request)
    ratelimit.check(f"reset:ip:{ip}", 5, 3600)
    if not captcha.verify(body.turnstile, ip):
        raise HTTPException(400, "The anti-bot check failed. Reload and try again.")
    email = accounts.norm_email(body.email)
    ratelimit.check(f"reset:email:{email}", 3, 3600)
    with closing(db.connect()) as conn:
        account = accounts.by_email(conn, email)
        if account:
            token = accounts.issue_email_token(conn, account["id"], "reset", config.RESET_TOKEN_TTL)
            db.audit(conn, "account.reset_request", account["id"], account["id"], ip)
            conn.commit()
    if account:
        send_mail(email, *accounts.reset_mail(account, token))
    return {"ok": True}


class ResetConfirmBody(BaseModel):
    token: str
    password: str


@router.post("/reset/confirm")
def reset_confirm(body: ResetConfirmBody, request: Request):
    ratelimit.check(f"reset-confirm:ip:{ratelimit.client_ip(request)}", 20, 600)
    accounts.check_password(body.password)
    with closing(db.connect()) as conn:
        found = accounts.consume_email_token(conn, body.token, "reset")
        if not found:
            raise HTTPException(400, "This link is not valid any more. Ask for a new one.")
        account, _ = found
        accounts.set_password(conn, account["id"], body.password)
        accounts.mark_verified(conn, account["id"])  # the mail reached them
        token = sessions.create(conn, account["id"], request)
        conn.commit()
        account = accounts.by_id(conn, account["id"])
    resp = JSONResponse({"account": accounts.public(account)})
    sessions.set_cookie(resp, token)
    return resp


# --- e-mail change ------------------------------------------------------------

class EmailChangeBody(BaseModel):
    new_email: str
    password: str = ""


@router.post("/email/change")
def email_change(body: EmailChangeBody, request: Request):
    new_email = accounts.norm_email(body.new_email)
    with closing(db.connect()) as conn:
        account = portal_account(conn, request)
        if not accounts.confirm_ok(account, body.password):
            raise HTTPException(403, "The password is wrong.")
        ratelimit.check(f"email-change:{account['id']}", 3, 3600)
        if conn.execute("SELECT 1 FROM accounts WHERE email = ?", (new_email,)).fetchone():
            raise HTTPException(409, "There is already an account with that e-mail address.")
        token = accounts.issue_email_token(conn, account["id"], "change-email", config.VERIFY_TOKEN_TTL, new_email)
        conn.commit()
    send_mail(new_email, *accounts.change_email_mail(account, new_email, token))
    return {"ok": True}


@router.post("/email/confirm")
def email_confirm(body: TokenBody, request: Request):
    ratelimit.check(f"email-confirm:ip:{ratelimit.client_ip(request)}", 20, 600)
    with closing(db.connect()) as conn:
        found = accounts.consume_email_token(conn, body.token, "change-email")
        if not found:
            raise HTTPException(400, "This link is not valid any more.")
        account, new_email = found
        old_email = account["email"]
        accounts.set_email(conn, account["id"], new_email)
        conn.commit()
    try:
        mail.send(old_email, *accounts.email_changed_notice(account, new_email))
    except mail.MailError as e:  # the change is done; the courtesy notice may fail
        log.warning("mail to %s failed: %s", old_email, e)
    return {"ok": True, "email": new_email}


# --- devices ------------------------------------------------------------------

@router.get("/devices")
def list_devices(request: Request):
    """The signed-in Gamma apps (grants) and browsers (portal sessions)."""
    with closing(db.connect()) as conn:
        account = portal_account(conn, request)
        return {"devices": oidc.devices(conn, account["id"]),
                "browsers": sessions.of_account(conn, account["id"], request)}


@router.post("/devices/{grant_id}/revoke")
def revoke_device(grant_id: str, request: Request):
    with closing(db.connect()) as conn:
        account = portal_account(conn, request)
        row = conn.execute("SELECT id FROM grants WHERE id = ? AND account_id = ?", (grant_id, account["id"])).fetchone()
        if not row:
            raise HTTPException(404, "no such device")
        oidc.revoke_grant(conn, grant_id, actor=account["id"])
        conn.commit()
    return {"ok": True}


@router.post("/sessions/{session_id}/revoke")
def end_session(session_id: str, request: Request):
    """Sign one browser out (the Devices page's Browsers list)."""
    with closing(db.connect()) as conn:
        account = portal_account(conn, request)
        if not sessions.end(conn, account["id"], session_id):
            raise HTTPException(404, "no such browser")
        db.audit(conn, "session.end", account["id"], account["id"], session_id)
        conn.commit()
    return {"ok": True}


@router.post("/devices/revoke-all")
def revoke_all(request: Request):
    """Sign out everywhere: every device and every other browser."""
    with closing(db.connect()) as conn:
        account = portal_account(conn, request)
        accounts.revoke_everything(conn, account["id"])
        token = sessions.create(conn, account["id"], request)
        db.audit(conn, "account.revoke_all", account["id"], account["id"])
        conn.commit()
    resp = JSONResponse({"ok": True})
    sessions.set_cookie(resp, token)
    return resp
