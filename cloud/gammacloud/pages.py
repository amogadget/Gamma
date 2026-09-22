"""The portal's HTML: sign in, register, verify, reset, the account page,
and the authorize page a Gamma server sends people to. Server-rendered
shells with a few lines of inline script that post JSON to ``/api`` — no
build step, no framework. Every value put in the page goes through
``esc``."""

import html
import json

from . import config

CSS = """
:root{--bg:#f6f6f4;--card:#fff;--ink:#1c1c1a;--muted:#6b6b66;--line:#e4e4df;--accent:#2f5bea;--danger:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--ink:#ececea;--muted:#9a9a94;--line:#33332f;--accent:#7a9cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:440px;margin:6vh auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 16px}h2{font-size:15px;margin:24px 0 8px}p{margin:8px 0}.muted{color:var(--muted);font-size:13px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}input{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}button.danger{background:var(--danger)}button.inline{width:auto;margin:0;padding:6px 10px;font-weight:500}
.error{color:var(--danger);font-size:13px;min-height:1.2em;margin-top:8px}.ok{color:var(--accent)}a{color:var(--accent)}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.brand{font-weight:700;letter-spacing:.02em;margin-bottom:8px;color:var(--muted);font-size:13px}
"""

JS = """
async function api(path, body, method){
  const r = await fetch(path, {method: method || 'POST', headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin'});
  let data = {}; try { data = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(data.detail || ('Request failed (' + r.status + ')'));
  return data;
}
function bind(formId, fn){
  const f = document.getElementById(formId); if (!f) return;
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault(); const err = f.querySelector('.error'); err.textContent = ''; err.classList.remove('ok');
    const data = Object.fromEntries(new FormData(f).entries());
    const ts = f.querySelector('[name=cf-turnstile-response]'); if (ts) data.turnstile = ts.value;
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try { await fn(data, err); } catch (e) { err.textContent = e.message; } finally { btn.disabled = false; }
  });
}
"""


def esc(value) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def shell(title: str, body: str, script: str = "") -> str:
    turnstile = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' \
        if config.TURNSTILE_SITEKEY else ""
    return (f"<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<title>{esc(title)} · Gamma Cloud</title><style>{CSS}</style>{turnstile}</head><body><main>"
            f"<div class=brand>GAMMA CLOUD</div><div class=card>{body}</div></main>"
            f"<script>{JS}{script}</script></body></html>")


def turnstile_widget() -> str:
    if not config.TURNSTILE_SITEKEY:
        return ""
    return f'<div class="cf-turnstile" data-sitekey="{esc(config.TURNSTILE_SITEKEY)}" style="margin-top:12px"></div>'


def error_page(title: str, message: str) -> str:
    return shell(title, f"<h1>{esc(title)}</h1><p>{esc(message)}</p>")


def login_page(next_url: str = "/") -> str:
    body = (f"<h1>Sign in</h1><form id=f><label>E-mail or handle<input name=login autocomplete=username required autofocus></label>"
            f"<label>Password<input name=password type=password autocomplete=current-password required></label>"
            f"<button type=submit>Sign in</button><div class=error></div></form>"
            f"<p class=muted><a href=/reset>Forgot your password?</a>"
            + (" · <a href=/register>Create an account</a>" if config.REGISTRATION != "closed" else "") + "</p>")
    script = f"bind('f', async d => {{ await api('/api/login', d); location.href = {json.dumps(next_url)}; }});"
    return shell("Sign in", body, script)


def register_page() -> str:
    if config.REGISTRATION == "closed":
        return error_page("Registration is closed", "Gamma Cloud is not taking new accounts right now.")
    invite = ("<label>Invite code<input name=invite required></label>" if config.REGISTRATION == "invite" else "")
    body = (f"<h1>Create your account</h1><form id=f>"
            f"<label>E-mail<input name=email type=email autocomplete=email required autofocus></label>"
            f"<label>Handle <span class=muted>(your username on every Gamma server)</span><input name=handle autocomplete=username "
            f"pattern='[a-z0-9][a-z0-9-]{{1,30}}[a-z0-9]' required></label>"
            f"<label>Password<input name=password type=password autocomplete=new-password minlength=8 required></label>"
            f"{invite}{turnstile_widget()}<button type=submit>Create account</button><div class=error></div></form>"
            f"<p class=muted>Already have one? <a href=/login>Sign in</a></p>")
    script = "bind('f', async d => { await api('/api/register', d); location.href = '/'; });"
    return shell("Create your account", body, script)


def verify_page(token: str) -> str:
    body = "<h1>Confirming your e-mail…</h1><p id=msg class=muted>One moment.</p>"
    script = (f"api('/api/verify', {{token: {json.dumps(token)}}}).then(() => {{ document.getElementById('msg').textContent = "
              f"'Your e-mail address is confirmed.'; setTimeout(() => location.href = '/', 1200); }})"
              f".catch(e => {{ document.getElementById('msg').textContent = e.message; }});")
    return shell("Confirm e-mail", body, script)


def email_confirm_page(token: str) -> str:
    body = "<h1>Changing your e-mail…</h1><p id=msg class=muted>One moment.</p>"
    script = (f"api('/api/email/confirm', {{token: {json.dumps(token)}}}).then(d => {{ document.getElementById('msg').textContent = "
              f"'Your e-mail address is now ' + d.email + '.'; setTimeout(() => location.href = '/', 1500); }})"
              f".catch(e => {{ document.getElementById('msg').textContent = e.message; }});")
    return shell("Confirm e-mail", body, script)


def reset_page() -> str:
    body = (f"<h1>Reset your password</h1><p class=muted>We will mail you a link if there is an account with that address.</p>"
            f"<form id=f><label>E-mail<input name=email type=email required autofocus></label>{turnstile_widget()}"
            f"<button type=submit>Send the link</button><div class=error></div></form><p class=muted><a href=/login>Back to sign in</a></p>")
    script = ("bind('f', async (d, err) => { await api('/api/reset/request', d); err.classList.add('ok'); "
              "err.textContent = 'Check your mail.'; });")
    return shell("Reset password", body, script)


def reset_confirm_page(token: str) -> str:
    body = (f"<h1>Choose a new password</h1><form id=f><label>New password<input name=password type=password "
            f"autocomplete=new-password minlength=8 required autofocus></label><button type=submit>Set password</button>"
            f"<div class=error></div></form>")
    script = (f"bind('f', async d => {{ await api('/api/reset/confirm', {{token: {json.dumps(token)}, password: d.password}}); "
              f"location.href = '/'; }});")
    return shell("New password", body, script)


def account_page(account: dict, devices: list[dict]) -> str:
    verified = ("" if account["email_verified"] else
                "<p class=error>Your e-mail address is not confirmed yet. Gamma servers will not sign you in until it is. "
                "<button class='inline secondary' id=resend>Resend the mail</button></p>")
    rows = "".join(
        f"<div class=row><div><b>{esc(d['client'])}</b><div class=muted>{esc(d['user_agent'][:60])} · last used {esc(d['last_used_at'][:10])}</div></div>"
        f"<button class='inline secondary' data-revoke='{esc(d['id'])}'>Sign out</button></div>" for d in devices) \
        or "<p class=muted>No apps or servers are signed in with this account.</p>"
    body = (f"<h1>{esc(account['handle'])}</h1><p class=muted>{esc(account['email'])} · {esc(account['plan'])} plan"
            + (" · admin" if account["is_admin"] else "") + f"</p>{verified}"
            f"<h2>Signed-in apps and servers</h2><div id=devices>{rows}</div>"
            f"<button class=secondary id=revokeall>Sign out everywhere</button>"
            f"<h2>Display name</h2><form id=name><input name=display_name value='{esc(account['display_name'])}' maxlength=100>"
            f"<button type=submit class=secondary>Save</button><div class=error></div></form>"
            f"<h2>Password</h2><form id=pw><label>Current<input name=current type=password autocomplete=current-password required></label>"
            f"<label>New<input name=new type=password autocomplete=new-password minlength=8 required></label>"
            f"<button type=submit class=secondary>Change password</button><div class=error></div></form>"
            f"<h2>E-mail</h2><form id=em><label>New address<input name=new_email type=email required></label>"
            f"<label>Password<input name=password type=password autocomplete=current-password required></label>"
            f"<button type=submit class=secondary>Send confirmation</button><div class=error></div></form>"
            f"<h2>Sign out</h2><button class=secondary id=logout>Sign out of this browser</button>"
            f"<h2>Delete account</h2><form id=del><label>Password<input name=password type=password required></label>"
            f"<button type=submit class=danger>Delete my account</button><div class=error></div></form>")
    script = """
const r = document.getElementById('resend'); if (r) r.onclick = async () => { r.disabled = true; try { await api('/api/verify/resend', {}); r.textContent = 'Sent'; } catch (e) { r.textContent = e.message; } };
document.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { await api('/api/devices/' + b.dataset.revoke + '/revoke', {}); location.reload(); });
document.getElementById('revokeall').onclick = async () => { await api('/api/devices/revoke-all', {}); location.reload(); };
document.getElementById('logout').onclick = async () => { await api('/api/logout', {}); location.href = '/login'; };
bind('name', async (d, err) => { await api('/api/me', d, 'PATCH'); err.classList.add('ok'); err.textContent = 'Saved.'; });
bind('pw', async (d, err) => { await api('/api/me/password', d); err.classList.add('ok'); err.textContent = 'Changed. Other devices were signed out.'; });
bind('em', async (d, err) => { await api('/api/email/change', d); err.classList.add('ok'); err.textContent = 'Check the new address for a confirmation link.'; });
bind('del', async d => { if (!confirm('Delete this account? This cannot be undone.')) return; await api('/api/me/delete', d); location.href = '/login'; });
"""
    return shell("Your account", body, script)


def authorize_page(req: dict, account, verify_needed: bool = False) -> str:
    client = req["client"]
    who = esc(client["name"])
    rid = json.dumps(req["id"])
    if account and verify_needed:
        body = (f"<h1>Confirm your e-mail first</h1><p><b>{who}</b> wants to sign you in as <b>{esc(account['handle'])}</b>, "
                f"but your e-mail address is not confirmed yet. Open the link we mailed you, then try again from the app.</p>"
                f"<button class=secondary id=resend>Resend the mail</button><div class=error id=err></div>"
                f"<p class=muted><a href=/>Your account</a></p>")
        script = ("document.getElementById('resend').onclick = async (ev) => { ev.target.disabled = true; try { await api('/api/verify/resend', {}); "
                  "ev.target.textContent = 'Sent'; } catch (e) { document.getElementById('err').textContent = e.message; } };")
        return shell("Confirm e-mail", body, script)
    if account:
        body = (f"<h1>Sign in to {who}</h1><p>Continue as <b>{esc(account['handle'])}</b> ({esc(account['email'])})?</p>"
                f"<button id=go>Continue</button><button class=secondary id=other>Use another account</button>"
                f"<button class=secondary id=cancel>Cancel</button><div class=error id=err></div>")
        script = (f"document.getElementById('go').onclick = async () => {{ try {{ const d = await api('/authorize/continue', {{request_id: {rid}}}); "
                  f"location.href = d.redirect; }} catch (e) {{ document.getElementById('err').textContent = e.message; }} }};"
                  f"document.getElementById('other').onclick = async () => {{ await api('/api/logout', {{}}); location.reload(); }};"
                  f"document.getElementById('cancel').onclick = async () => {{ const d = await api('/authorize/cancel', {{request_id: {rid}}}); "
                  f"if (d.redirect) location.href = d.redirect; }};")
        return shell(f"Sign in to {client['name']}", body, script)
    body = (f"<h1>Sign in to {who}</h1><form id=f><label>E-mail or handle<input name=login autocomplete=username required autofocus></label>"
            f"<label>Password<input name=password type=password autocomplete=current-password required></label>"
            f"<button type=submit>Sign in</button><div class=error></div></form>"
            f"<p class=muted><a href=/reset>Forgot your password?</a>"
            + (" · <a href=/register>Create an account</a>" if config.REGISTRATION != "closed" else "") + "</p>")
    script = (f"bind('f', async d => {{ const r = await api('/authorize/login', {{request_id: {rid}, login: d.login, password: d.password}}); "
              f"if (r.verify_needed) location.reload(); else location.href = r.redirect; }});")
    return shell(f"Sign in to {client['name']}", body, script)
