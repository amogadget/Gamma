"""The portal's HTML.

Two shells: ``auth`` (a centred card: sign in, register, verify, reset,
the authorize page a Gamma server sends people to) and ``app`` (a sidebar
plus a content column: Overview, Devices, Settings and, for admins, Admin).
Server-rendered, in the gammapdf.com palette (``sites/site/styles.css``)
with the quiet, bordered, low-radius look of a workspace tool rather than
a marketing page; light and dark; no framework, no build. The pages carry
a few lines of inline script that post JSON to ``/api``. Every value put in
the page goes through ``esc``.
"""

import html
import json

from . import config

SITE = "https://gammapdf.com"

LOGO = ('<svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
        '<rect width="32" height="32" rx="7" fill="#1e1e1c"/>'
        '<path d="M 6 16 C 9 10.5 13 10.5 16 16 C 19 21.5 23 21.5 26 16" stroke="#e8a020" stroke-width="1.2" fill="none" opacity="0.6" stroke-linecap="round"/>'
        '<path d="M 6 16 C 9 21.5 13 21.5 16 16 C 19 10.5 23 10.5 26 16" stroke="#e8a020" stroke-width="1.2" fill="none" opacity="0.6" stroke-linecap="round"/>'
        '<path d="M 6 4 Q 2 16 6 28" stroke="#e8a020" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.9"/>'
        '<path d="M 26 4 Q 30 16 26 28" stroke="#e8a020" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.9"/>'
        '<rect x="9" y="8" width="13" height="3" rx="0.8" fill="#eeebe4"/><rect x="9" y="8" width="3" height="15" rx="0.8" fill="#eeebe4"/></svg>')

CSS = """
:root{--bg:#f7f6f3;--surface:#fff;--surface-2:#f1efea;--text:#1f1e1b;--text-2:#5f5c55;--muted:#8a877e;--line:#e6e3db;--line-2:#d9d5cb;--accent:#e8a020;--accent-ink:#9a6206;--accent-soft:#faf0d9;--dark:#1e1e1c;--dark-fg:#eeebe4;--danger:#b3261e;--danger-soft:#fbe9e7;--ok:#2f7a3d;--ok-soft:#e3f2e5;--font:Inter,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace;color-scheme:light}
@media(prefers-color-scheme:dark){:root{--bg:#191918;--surface:#202020;--surface-2:#262625;--text:#ecebe6;--text-2:#b5b2a9;--muted:#85827a;--line:#2f2f2c;--line-2:#3b3b37;--accent-ink:#f0b74a;--accent-soft:#3a301d;--danger:#e5766d;--danger-soft:#3a2422;--ok:#7fc98d;--ok-soft:#1e3122;color-scheme:dark}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased;min-height:100vh}
a{color:var(--accent-ink);text-decoration:none}a:hover{text-decoration:underline}h1,h2,h3{margin:0;line-height:1.2;letter-spacing:-.01em;font-weight:600}h1{font-size:24px}h2{font-size:15px}p{margin:0}code{font-family:var(--mono);font-size:12.5px;background:var(--surface-2);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 12px;border-radius:6px;font:inherit;font-weight:500;font-size:14px;line-height:1.2;border:1px solid var(--line-2);background:var(--surface);color:var(--text);white-space:nowrap;cursor:pointer;text-decoration:none;transition:background-color .1s,border-color .1s}
.btn:hover{background:var(--surface-2);text-decoration:none}.btn:disabled{opacity:.5;cursor:default}
.btn--primary{background:var(--dark);color:var(--dark-fg);border-color:var(--dark)}.btn--primary:hover{background:#31312e}
.btn--danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,var(--line-2))}.btn--danger:hover{background:var(--danger-soft)}
.btn--sm{padding:4px 9px;font-size:13px}.btn--block{width:100%;padding:9px 12px}
@media(prefers-color-scheme:dark){.btn--primary{background:var(--accent);color:#1a1a18;border-color:var(--accent)}.btn--primary:hover{background:#f0b03a}}
label{display:block;font-size:12.5px;font-weight:500;color:var(--text-2);margin:12px 0 5px}label small{font-weight:400;color:var(--muted)}
input,select{width:100%;padding:8px 10px;border:1px solid var(--line-2);border-radius:6px;background:var(--surface);color:inherit;font:inherit;font-size:14px}input:focus,select:focus{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:0;border-color:var(--accent)}
form .btn{margin-top:14px}.msg{min-height:1.3em;font-size:13px;margin-top:8px;color:var(--danger)}.msg.ok{color:var(--ok)}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:500;padding:2px 8px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);color:var(--text-2);white-space:nowrap}
.pill--ok{background:var(--ok-soft);color:var(--ok);border-color:transparent}.pill--warn{background:var(--accent-soft);color:var(--accent-ink);border-color:transparent}.pill--plan{text-transform:capitalize}
/* auth shell */
.authwrap{min-height:100vh;display:flex;flex-direction:column}.authtop{display:flex;align-items:center;gap:10px;padding:18px 24px;font-weight:600;color:var(--text)}.authtop a{color:inherit}.authtop em{font-style:normal;color:var(--accent);font-weight:500;margin-left:3px}
.auth{margin:6vh auto 40px;width:min(400px,100% - 32px)}.auth h1{font-size:22px;margin-bottom:6px}.auth .lead{color:var(--text-2);margin-bottom:18px;font-size:14px}.auth .links{margin-top:16px;font-size:13px;color:var(--text-2);display:flex;gap:14px;flex-wrap:wrap}
.card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:22px}
/* app shell */
.app{display:grid;grid-template-columns:232px 1fr;min-height:100vh}
.side{background:var(--surface-2);border-right:1px solid var(--line);padding:14px 10px;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh}
.side .brand{display:flex;align-items:center;gap:9px;padding:6px 8px 14px;font-weight:600;font-size:15px;color:var(--text)}.side .brand em{font-style:normal;color:var(--accent);font-weight:500;margin-left:3px}.side .brand:hover{text-decoration:none}
.side a.item,.side button.item{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:6px;color:var(--text-2);font:inherit;font-weight:500;background:none;border:0;text-align:left;cursor:pointer;width:100%}
.side .item:hover{background:color-mix(in srgb,var(--text) 6%,transparent);text-decoration:none;color:var(--text)}.side .item.on{background:color-mix(in srgb,var(--text) 9%,transparent);color:var(--text)}
.side .item svg{width:16px;height:16px;flex:none;opacity:.8}.side .grow{flex:1}.side .label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:12px 8px 4px}
.side .me{display:flex;align-items:center;gap:9px;padding:8px;border-top:1px solid var(--line);margin-top:6px;font-size:13px}.side .me .avatar{width:26px;height:26px;font-size:12px}.side .me div{min-width:0}.side .me b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.side .me span{color:var(--muted);font-size:12px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avatar{width:32px;height:32px;border-radius:50%;background:var(--accent-soft);color:var(--accent-ink);font-weight:600;display:grid;place-items:center;text-transform:uppercase;flex:none}
.main{padding:40px 48px 64px;max-width:920px;width:100%}.main>header{margin-bottom:22px}.main>header p{color:var(--text-2);margin-top:4px}
.section{background:var(--surface);border:1px solid var(--line);border-radius:8px;margin-bottom:16px}.section>h2{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px}.section>h2 span{font-weight:400;color:var(--muted);font-size:13px}.section>.body{padding:14px 16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}.stat{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.stat span{display:block;color:var(--muted);font-size:12px;margin-bottom:4px}.stat b{font-size:16px;font-weight:600;text-transform:capitalize}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.row:first-child{border-top:0}.row .sub{color:var(--muted);font-size:12px;display:block}.row b{font-weight:500}
.notice{background:var(--accent-soft);color:var(--accent-ink);border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);border-radius:8px;padding:10px 14px;font-size:13.5px;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.empty{color:var(--text-2);font-size:13.5px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.actions .btn{margin-top:0}
.danger{border-color:color-mix(in srgb,var(--danger) 35%,var(--line))}.danger>h2{color:var(--danger)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:640px){.grid2{grid-template-columns:1fr}}
form.inline{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}form.inline label{margin:0;flex:1;min-width:120px}form.inline .btn{margin:0}
table{width:100%;border-collapse:collapse;font-size:13.5px}th{text-align:left;color:var(--muted);font-weight:500;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line)}td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}tr:last-child td{border-bottom:0}td .btn{margin:0}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:16px}.tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:8px 12px;font:inherit;font-weight:500;color:var(--text-2);cursor:pointer;margin-bottom:-1px}.tabs button.on{color:var(--text);border-bottom-color:var(--text)}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}.toolbar input{max-width:320px}.toolbar .spacer{flex:1}
select.sm{width:auto;padding:3px 6px;font-size:13px}.mono{font-family:var(--mono);font-size:12px}
.secretbox{background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);border-radius:6px;padding:10px 12px;margin-top:10px;font-family:var(--mono);font-size:12.5px;word-break:break-all;white-space:pre-wrap}
@media(max-width:820px){.app{grid-template-columns:1fr}.side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:4px;padding:10px}.side .brand{padding:4px 8px}.side .label,.side .me{display:none}.side .grow{display:none}.side a.item,.side button.item{width:auto}.main{padding:24px 16px 48px}}
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
    ev.preventDefault(); const msg = f.querySelector('.msg'); msg.textContent = ''; msg.classList.remove('ok');
    const data = Object.fromEntries(new FormData(f).entries());
    const ts = f.querySelector('[name=cf-turnstile-response]'); if (ts) data.turnstile = ts.value;
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try { await fn(data, msg); } catch (e) { msg.textContent = e.message; } finally { btn.disabled = false; }
  });
}
function say(msg, text){ msg.classList.add('ok'); msg.textContent = text; }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const out = document.getElementById('signout'); if (out) out.onclick = async (e) => { e.preventDefault(); await api('/api/logout', {}); location.href = '/login'; };
"""

ICONS = {
    "home": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z"/></svg>',
    "devices": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    "settings": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    "admin": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    "download": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
    "docs": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5z"/></svg>',
    "out": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
}


def esc(value) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def _head(title: str) -> str:
    turnstile = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' \
        if config.TURNSTILE_SITEKEY else ""
    return (f"<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<title>{esc(title)} · Gamma Cloud</title><meta name=color-scheme content='light dark'>"
            f"<link rel=icon type=image/svg+xml href='data:image/svg+xml,{html.escape(LOGO.replace('#', '%23'))}'>"
            f"<style>{CSS}</style>{turnstile}</head>")


def auth(title: str, lead: str, inner: str, script: str = "") -> str:
    return (_head(title) + f"<body><div class=authwrap><div class=authtop><a href='{SITE}'>{LOGO}</a><a href='/'>Gamma<em>Cloud</em></a></div>"
            f"<div class='auth card'><h1>{esc(title)}</h1>" + (f"<p class=lead>{lead}</p>" if lead else "") + f"{inner}</div></div>"
            f"<script>{JS}{script}</script></body></html>")


def app(title: str, lead: str, account: dict, active: str, inner: str, script: str = "") -> str:
    def item(key, href, label):
        return f"<a class='item {'on' if key == active else ''}' href='{href}'>{ICONS[key]}{label}</a>"
    nav = item("home", "/", "Overview") + item("devices", "/devices", "Devices") + item("settings", "/settings", "Settings")
    if account["is_admin"]:
        nav += "<div class=label>Server</div>" + item("admin", "/admin", "Admin")
    nav += ("<div class=label>Gamma</div>"
            f"<a class=item href='{SITE}/download'>{ICONS['download']}Download the app</a>"
            f"<a class=item href='{SITE}/docs'>{ICONS['docs']}Docs</a>")
    side = (f"<aside class=side><a class=brand href='/'>{LOGO}Gamma<em>Cloud</em></a>{nav}<div class=grow></div>"
            f"<button class=item id=signout>{ICONS['out']}Sign out</button>"
            f"<div class=me><div class=avatar>{esc(account['username'][:1])}</div><div><b>{esc(account['username'])}</b><span>{esc(account['email'])}</span></div></div></aside>")
    return (_head(title) + f"<body><div class=app>{side}<div class=main><header><h1>{esc(title)}</h1>" + (f"<p>{lead}</p>" if lead else "")
            + f"</header>{inner}</div></div><script>{JS}{script}</script></body></html>")


def turnstile_widget() -> str:
    if not config.TURNSTILE_SITEKEY:
        return ""
    return f'<div class="cf-turnstile" data-sitekey="{esc(config.TURNSTILE_SITEKEY)}" style="margin-top:14px"></div>'


def error_page(title: str, message: str) -> str:
    return auth(title, esc(message), "<p class=links><a href='/'>Back</a></p>")


def _register_link() -> str:
    return "<a href=/register>Create an account</a>" if config.REGISTRATION != "closed" else ""


# --- auth pages ---------------------------------------------------------------

def login_page(next_url: str = "/") -> str:
    inner = ("<form id=f><label>E-mail or username<input name=login autocomplete=username required autofocus></label>"
             "<label>Password<input name=password type=password autocomplete=current-password required></label>"
             "<button type=submit class='btn btn--primary btn--block'>Sign in</button><div class=msg></div></form>"
             f"<p class=links><a href=/reset>Forgot your password?</a>{_register_link()}</p>")
    script = f"bind('f', async d => {{ await api('/api/login', d); location.href = {json.dumps(next_url)}; }});"
    return auth("Sign in", "One account for the desktop app and every Gamma server.", inner, script)


def register_page() -> str:
    if config.REGISTRATION == "closed":
        return error_page("Registration is closed", "Gamma Cloud is not taking new accounts right now.")
    invite = "<label>Invite code<input name=invite required autocomplete=off></label>" if config.REGISTRATION == "invite" else ""
    inner = ("<form id=f><label>E-mail<input name=email type=email autocomplete=email required autofocus></label>"
             "<label>Username <small>lowercase letters, digits, hyphens</small><input name=username autocomplete=username "
             "pattern='[a-z0-9][a-z0-9-]{1,30}[a-z0-9]' required></label>"
             "<label>Password<input name=password type=password autocomplete=new-password minlength=8 required></label>"
             f"{invite}{turnstile_widget()}<button type=submit class='btn btn--primary btn--block'>Create account</button><div class=msg></div></form>"
             "<p class=links>Already have one? <a href=/login>Sign in</a></p>")
    script = "bind('f', async d => { await api('/api/register', d); location.href = '/'; });"
    return auth("Create your account", "Free. You can change the username and e-mail later.", inner, script)


def verify_page(token: str) -> str:
    script = (f"api('/api/verify', {{token: {json.dumps(token)}}}).then(() => {{ document.getElementById('msg').textContent = "
              f"'Your e-mail address is confirmed. Taking you to your account…'; setTimeout(() => location.href = '/', 1200); }})"
              f".catch(e => {{ document.getElementById('msg').textContent = e.message; }});")
    return auth("Confirming your e-mail", "One moment.", "<p id=msg class=msg></p><p class=links><a href='/'>Overview</a></p>", script)


def email_confirm_page(token: str) -> str:
    script = (f"api('/api/email/confirm', {{token: {json.dumps(token)}}}).then(d => {{ document.getElementById('msg').textContent = "
              f"'Your e-mail address is now ' + d.email + '.'; setTimeout(() => location.href = '/', 1500); }})"
              f".catch(e => {{ document.getElementById('msg').textContent = e.message; }});")
    return auth("Changing your e-mail", "One moment.", "<p id=msg class=msg></p><p class=links><a href='/'>Overview</a></p>", script)


def reset_page() -> str:
    inner = (f"<form id=f><label>E-mail<input name=email type=email required autofocus></label>{turnstile_widget()}"
             "<button type=submit class='btn btn--primary btn--block'>Send the link</button><div class=msg></div></form>"
             "<p class=links><a href=/login>Back to sign in</a></p>")
    script = "bind('f', async (d, msg) => { await api('/api/reset/request', d); say(msg, 'Check your mail.'); });"
    return auth("Reset your password", "We will mail you a link if there is an account with that address.", inner, script)


def reset_confirm_page(token: str) -> str:
    inner = ("<form id=f><label>New password<input name=password type=password autocomplete=new-password minlength=8 required autofocus></label>"
             "<button type=submit class='btn btn--primary btn--block'>Set password</button><div class=msg></div></form>")
    script = (f"bind('f', async d => {{ await api('/api/reset/confirm', {{token: {json.dumps(token)}, password: d.password}}); "
              f"location.href = '/'; }});")
    return auth("Choose a new password", "Every other browser and device will be signed out.", inner, script)


# --- the app pages ------------------------------------------------------------

def _notice(account: dict) -> str:
    if account["email_verified"]:
        return ""
    return ("<div class=notice><span><b>E-mail not confirmed.</b> Gamma servers will not sign you in until you open the link we mailed you.</span>"
            "<button class='btn btn--sm' id=resend>Resend the mail</button></div>")


RESEND_JS = "const r = document.getElementById('resend'); if (r) r.onclick = async () => { r.disabled = true; try { await api('/api/verify/resend', {}); r.textContent = 'Sent'; } catch (e) { r.textContent = e.message; } };"


def overview_page(account: dict, devices: list[dict]) -> str:
    verified = account["email_verified"]
    stats = (f"<div class=stats><div class=stat><span>Plan</span><b>{esc(account['plan'])}</b></div>"
             f"<div class=stat><span>E-mail</span><b>{'Confirmed' if verified else 'Not confirmed'}</b></div>"
             f"<div class=stat><span>Signed-in apps</span><b>{len(devices)}</b></div>"
             f"<div class=stat><span>Member since</span><b>{esc(account['created_at'][:10])}</b></div></div>")
    servers = ("<div class=section><h2>Your Gamma servers <span>where this account signs in</span></h2><div class=body>"
               "<p class=empty>A hosted Gamma server of your own comes with the Plus and Pro plans. Until then the desktop app is your "
               "library: install it and choose <b>Sign in with Gamma Cloud</b> on its login page.</p>"
               f"<div class=actions><a class='btn btn--primary btn--sm' href='{SITE}/download'>Download the desktop app</a>"
               f"<a class='btn btn--sm' href='{SITE}/#selfhost'>Self-host instead</a></div></div></div>")
    recent = "".join(f"<div class=row><span><b>{esc(d['client'])}</b><span class=sub>{esc((d.get('user_agent') or '')[:70])}</span></span>"
                     f"<span class=sub>{esc(d['last_used_at'][:10])}</span></div>" for d in devices[:3]) \
        or "<p class=empty>Nothing has signed in with this account yet.</p>"
    apps = f"<div class=section><h2>Recent sign-ins <span><a href='/devices'>all devices</a></span></h2><div class=body>{recent}</div></div>"
    who = (f"<div class=section><h2>Account</h2><div class=body>"
           f"<div class=row><span>Username<span class=sub>your name on every Gamma server</span></span><b>{esc(account['username'])}</b></div>"
           f"<div class=row><span>E-mail</span><b>{esc(account['email'])}</b></div>"
           f"<div class=row><span>Display name</span><b>{esc(account['display_name'] or '—')}</b></div>"
           f"<div class=row><span>Account id<span class=sub>what servers key on; never changes</span></span><span class=mono>{esc(account['id'])}</span></div>"
           f"<div class=actions><a class='btn btn--sm' href='/settings'>Edit in Settings</a></div></div></div>")
    lead = f"Signed in as <b>{esc(account['username'])}</b>" + (" · admin" if account["is_admin"] else "")
    return app("Overview", lead, account, "home", _notice(account) + stats + servers + apps + who, RESEND_JS)


def devices_page(account: dict, devices: list[dict]) -> str:
    rows = "".join(
        f"<div class=row><span><b>{esc(d['client'])}</b><span class=sub>{esc((d.get('user_agent') or '')[:80])}{' · ' if d.get('user_agent') else ''}"
        f"signed in {esc(d['created_at'][:10])} · last used {esc(d['last_used_at'][:10])}{' · ' + esc(d['ip']) if d.get('ip') else ''}</span></span>"
        f"<button class='btn btn--sm' data-revoke='{esc(d['id'])}'>Sign out</button></div>" for d in devices) \
        or "<p class=empty>No app or server holds a key to this account. Sign in to the desktop app or a Gamma server to see it here.</p>"
    inner = (f"<div class=section><h2>Signed-in apps and servers <span>{len(devices)}</span></h2><div class=body>{rows}"
             "<div class=actions><button class='btn btn--sm' id=revokeall>Sign out everywhere</button></div></div></div>"
             "<p class=empty>Signing a device out revokes its key at once. This browser stays signed in.</p>")
    script = ("document.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { await api('/api/devices/' + b.dataset.revoke + '/revoke', {}); location.reload(); });"
              "document.getElementById('revokeall').onclick = async () => { await api('/api/devices/revoke-all', {}); location.reload(); };")
    return app("Devices", "Everything that can act as this account.", account, "devices", inner, script)


def settings_page(account: dict) -> str:
    inner = (
        _notice(account)
        + "<div class=section><h2>Profile</h2><div class=body><div class=grid2>"
        f"<form id=name><label>Display name<input name=display_name value='{esc(account['display_name'])}' maxlength=100 placeholder='{esc(account['username'])}'></label>"
        "<button type=submit class='btn btn--sm'>Save</button><div class=msg></div></form>"
        f"<form id=user><label>Username <small>lowercase; your name on Gamma servers</small><input name=username value='{esc(account['username'])}' "
        "pattern='[a-z0-9][a-z0-9-]{1,30}[a-z0-9]' required></label><label>Password<input name=password type=password autocomplete=current-password required></label>"
        "<button type=submit class='btn btn--sm'>Change username</button><div class=msg></div></form></div></div></div>"
        "<div class=section><h2>E-mail <span>a confirmation goes to the new address</span></h2><div class=body>"
        f"<form id=em><div class=inlinerow><label>New address<input name=new_email type=email placeholder='{esc(account['email'])}' required></label>"
        "<label>Password<input name=password type=password autocomplete=current-password required></label></div>"
        "<button type=submit class='btn btn--sm'>Send confirmation</button><div class=msg></div></form></div></div>"
        "<div class=section><h2>Password <span>other browsers and devices are signed out</span></h2><div class=body>"
        "<form id=pw><div class=inlinerow><label>Current<input name=current type=password autocomplete=current-password required></label>"
        "<label>New<input name=new type=password autocomplete=new-password minlength=8 required></label></div>"
        "<button type=submit class='btn btn--sm'>Change password</button><div class=msg></div></form></div></div>"
        "<div class='section danger'><h2>Delete account</h2><div class=body><p class=empty>Signs everything out and removes the account after a grace period. Gamma servers keep their data.</p>"
        "<form id=del><label>Password<input name=password type=password autocomplete=current-password required></label>"
        "<button type=submit class='btn btn--danger btn--sm'>Delete my account</button><div class=msg></div></form></div></div>"
        "<style>.inlinerow{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:640px){.inlinerow{grid-template-columns:1fr}}</style>")
    script = RESEND_JS + """
bind('name', async (d, msg) => { await api('/api/me', d, 'PATCH'); say(msg, 'Saved.'); });
bind('user', async (d, msg) => { const r = await api('/api/me/username', d); say(msg, 'Your username is now ' + r.account.username + '.'); setTimeout(() => location.reload(), 900); });
bind('em', async (d, msg) => { await api('/api/email/change', d); say(msg, 'Check the new address for a confirmation link.'); });
bind('pw', async (d, msg) => { await api('/api/me/password', d); say(msg, 'Changed. Other devices were signed out.'); });
bind('del', async d => { if (!confirm('Delete this account? This cannot be undone.')) return; await api('/api/me/delete', d); location.href = '/login'; });
"""
    return app("Settings", "Your profile and sign-in details.", account, "settings", inner, script)


def admin_page(account: dict) -> str:
    plans = "".join(f"<option value={p}>{p}</option>" for p in config.PLANS)
    inner = (
        "<div class=tabs><button class=on data-tab=accounts>Accounts</button><button data-tab=invites>Invites</button>"
        "<button data-tab=clients>Clients</button><button data-tab=audit>Audit log</button></div>"
        "<div id=tab-accounts><div class=toolbar><input id=q placeholder='Search username, e-mail or id' autocomplete=off><span class=spacer></span><span class=empty id=count></span></div>"
        "<div class=section><div class=body style='padding:0'><table><thead><tr><th>Username</th><th>E-mail</th><th>Plan</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody id=accounts></tbody></table></div></div>"
        "<div class=actions><button class='btn btn--sm' id=more>Load more</button></div></div>"
        "<div id=tab-invites hidden><div class=section><h2>New invite</h2><div class=body><form id=inv class=inline>"
        "<label>Uses<input name=uses type=number value=1 min=1 max=10000></label>"
        f"<label>Plan<select name=plan>{plans}</select></label><label>Note<input name=note placeholder='who it is for'></label>"
        "<button type=submit class='btn btn--primary btn--sm'>Create</button><div class=msg></div></form></div></div>"
        "<div class=section><div class=body style='padding:0'><table><thead><tr><th>Code</th><th>Uses left</th><th>Plan</th><th>Note</th><th>Created</th><th></th></tr></thead><tbody id=invites></tbody></table></div></div></div>"
        "<div id=tab-clients hidden><div class=section><h2>New client <span>a hosted Gamma server or the share host</span></h2><div class=body><form id=cli class=inline>"
        "<label>Name<input name=name required></label><label>Kind<select name=kind><option value=container>container</option><option value=share-host>share-host</option></select></label>"
        "<label>Callback URL<input name=redirect placeholder='https://name.gammapdf.com/api/auth/cloud/callback' required></label>"
        "<button type=submit class='btn btn--primary btn--sm'>Create</button><div class=msg></div></form><div id=secret hidden class=secretbox></div></div></div>"
        "<div class=section><div class=body style='padding:0'><table><thead><tr><th>Client id</th><th>Name</th><th>Kind</th><th>Callback</th><th></th></tr></thead><tbody id=clients></tbody></table></div></div></div>"
        "<div id=tab-audit hidden><div class=section><div class=body style='padding:0'><table><thead><tr><th>When</th><th>Event</th><th>Account</th><th>Actor</th><th>Detail</th></tr></thead><tbody id=audit></tbody></table></div></div></div>")
    script = """
const PLANS = %s; let offset = 0, query = '';
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  for (const t of ['accounts','invites','clients','audit']) document.getElementById('tab-' + t).hidden = t !== b.dataset.tab; if (b.dataset.tab !== 'accounts') load(b.dataset.tab); });
function planSelect(a){ return '<select class=sm data-plan="' + a.id + '">' + PLANS.map(p => '<option' + (p === a.plan ? ' selected' : '') + '>' + p + '</option>').join('') + '</select>'; }
function accountRow(a){
  const status = (a.deleted_at ? '<span class=pill>deleted</span> ' : '') + (a.email_verified ? '<span class="pill pill--ok">verified</span>' : '<span class="pill pill--warn">unverified</span>') + (a.is_admin ? ' <span class=pill>admin</span>' : '');
  return '<tr data-id="' + esc(a.id) + '"><td><b>' + esc(a.username) + '</b><br><span class=mono>' + esc(a.id) + '</span></td><td>' + esc(a.email) + '</td><td>' + planSelect(a) + '</td><td>' + status + '</td><td>' + esc(a.created_at.slice(0,10)) + '</td>'
    + '<td><select class=sm data-act="' + esc(a.id) + '"><option value="">Actions…</option>' + (a.email_verified ? '' : '<option value=verify>Mark verified</option><option value=resend>Resend verify mail</option>')
    + '<option value=rename>Rename…</option><option value=' + (a.is_admin ? 'unadmin>Remove admin' : 'admin>Make admin') + '</option>' + (a.deleted_at ? '' : '<option value=delete>Delete</option>') + '</select></td></tr>';
}
async function loadAccounts(reset){
  if (reset) { offset = 0; document.getElementById('accounts').innerHTML = ''; }
  const d = await api('/api/admin/accounts?q=' + encodeURIComponent(query) + '&offset=' + offset + '&limit=50', undefined, 'GET');
  document.getElementById('accounts').insertAdjacentHTML('beforeend', d.accounts.map(accountRow).join(''));
  offset += d.accounts.length; document.getElementById('count').textContent = offset + ' of ' + d.total; document.getElementById('more').hidden = offset >= d.total;
  wire();
}
function wire(){
  document.querySelectorAll('[data-plan]').forEach(s => s.onchange = async () => { try { await api('/api/admin/accounts/' + s.dataset.plan, {plan: s.value}, 'PATCH'); } catch (e) { alert(e.message); } });
  document.querySelectorAll('[data-act]').forEach(s => s.onchange = async () => {
    const id = s.dataset.act, v = s.value; s.value = '';
    try {
      if (v === 'verify') await api('/api/admin/accounts/' + id, {verified: true}, 'PATCH');
      else if (v === 'resend') { await api('/api/admin/accounts/' + id + '/resend-verify', {}); alert('Sent.'); return; }
      else if (v === 'admin' || v === 'unadmin') await api('/api/admin/accounts/' + id, {is_admin: v === 'admin'}, 'PATCH');
      else if (v === 'rename') { const u = prompt('New username (lowercase letters, digits, hyphens):'); if (!u) return; await api('/api/admin/accounts/' + id, {username: u}, 'PATCH'); }
      else if (v === 'delete') { if (!confirm('Delete this account? It is signed out everywhere and purged after the grace period.')) return; await api('/api/admin/accounts/' + id + '/delete', {}); }
      else return;
      loadAccounts(true);
    } catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-delinv]').forEach(b => b.onclick = async () => { await api('/api/admin/invites/' + b.dataset.delinv, undefined, 'DELETE'); load('invites'); });
  document.querySelectorAll('[data-delcli]').forEach(b => b.onclick = async () => { if (!confirm('Delete this client? Its servers can no longer sign people in.')) return; await api('/api/admin/clients/' + b.dataset.delcli, undefined, 'DELETE'); load('clients'); });
}
async function load(tab){
  if (tab === 'invites') { const d = await api('/api/admin/invites', undefined, 'GET'); document.getElementById('invites').innerHTML = d.invites.map(i => '<tr><td class=mono>' + esc(i.code) + '</td><td>' + i.uses_left + '</td><td>' + esc(i.plan) + '</td><td>' + esc(i.note) + '</td><td>' + esc(i.created_at.slice(0,10)) + '</td><td><button class="btn btn--sm" data-delinv="' + esc(i.code) + '">Delete</button></td></tr>').join('') || '<tr><td colspan=6 class=empty>No invites.</td></tr>'; }
  if (tab === 'clients') { const d = await api('/api/admin/clients', undefined, 'GET'); document.getElementById('clients').innerHTML = d.clients.map(c => '<tr><td class=mono>' + esc(c.client_id) + '</td><td>' + esc(c.name) + '</td><td>' + esc(c.kind) + '</td><td class=mono>' + esc(JSON.parse(c.redirect_uris).join(' ')) + '</td><td><button class="btn btn--sm" data-delcli="' + esc(c.client_id) + '">Delete</button></td></tr>').join('') || '<tr><td colspan=5 class=empty>No clients. Local Gammas need none.</td></tr>'; }
  if (tab === 'audit') { const d = await api('/api/admin/audit?limit=300', undefined, 'GET'); document.getElementById('audit').innerHTML = d.audit.map(a => '<tr><td class=mono>' + esc(a.at.slice(0,19).replace('T',' ')) + '</td><td>' + esc(a.event) + '</td><td class=mono>' + esc(a.account_id) + '</td><td class=mono>' + esc(a.actor) + '</td><td>' + esc(a.detail) + '</td></tr>').join(''); }
  wire();
}
let t; document.getElementById('q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { query = e.target.value; loadAccounts(true); }, 250); };
document.getElementById('more').onclick = () => loadAccounts(false);
bind('inv', async (d, msg) => { const r = await api('/api/admin/invites', {uses: Number(d.uses), plan: d.plan, note: d.note}); say(msg, 'Invite ' + r.invite.code + ' created.'); load('invites'); });
bind('cli', async (d, msg) => { const r = await api('/api/admin/clients', {name: d.name, kind: d.kind, redirect_uris: [d.redirect]}); const box = document.getElementById('secret'); box.hidden = false;
  box.textContent = 'GAMMA_CLOUD_CLIENT_ID=' + r.client_id + '\\nGAMMA_CLOUD_CLIENT_SECRET=' + r.client_secret + '   (shown once)'; say(msg, 'Client created.'); load('clients'); });
loadAccounts(true);
""" % json.dumps(list(config.PLANS))
    return app("Admin", "Accounts, invites, the clients of hosted servers, and what happened.", account, "admin", inner, script)


# --- the authorize page -------------------------------------------------------

def authorize_page(req: dict, account, verify_needed: bool = False) -> str:
    client = req["client"]
    who = esc(client["name"])
    rid = json.dumps(req["id"])
    if account and verify_needed:
        inner = (f"<p class=lead><b>{who}</b> wants to sign you in as <b>{esc(account['username'])}</b>, but your e-mail address is not "
                 "confirmed yet. Open the link we mailed you, then try again from the app.</p>"
                 "<button class='btn btn--block' id=resend>Resend the mail</button><div class=msg id=err></div>"
                 "<p class=links><a href=/>Your account</a></p>")
        script = ("document.getElementById('resend').onclick = async (ev) => { ev.target.disabled = true; try { await api('/api/verify/resend', {}); "
                  "ev.target.textContent = 'Sent'; } catch (e) { document.getElementById('err').textContent = e.message; } };")
        return auth("Confirm your e-mail first", "", inner, script)
    if account:
        inner = (f"<p class=lead>Continue as <b>{esc(account['username'])}</b> ({esc(account['email'])})?</p>"
                 "<button class='btn btn--primary btn--block' id=go>Continue</button>"
                 "<div class=actions><button class='btn btn--sm' id=other>Use another account</button>"
                 "<button class='btn btn--sm' id=cancel>Cancel</button></div><div class=msg id=err></div>")
        script = (f"document.getElementById('go').onclick = async () => {{ try {{ const d = await api('/authorize/continue', {{request_id: {rid}}}); "
                  f"location.href = d.redirect; }} catch (e) {{ document.getElementById('err').textContent = e.message; }} }};"
                  f"document.getElementById('other').onclick = async () => {{ await api('/api/logout', {{}}); location.reload(); }};"
                  f"document.getElementById('cancel').onclick = async () => {{ const d = await api('/authorize/cancel', {{request_id: {rid}}}); "
                  f"if (d.redirect) location.href = d.redirect; }};")
        return auth(f"Sign in to {client['name']}", "", inner, script)
    inner = ("<form id=f><label>E-mail or username<input name=login autocomplete=username required autofocus></label>"
             "<label>Password<input name=password type=password autocomplete=current-password required></label>"
             "<button type=submit class='btn btn--primary btn--block'>Sign in</button><div class=msg></div></form>"
             f"<p class=links><a href=/reset>Forgot your password?</a>{_register_link()}</p>")
    script = (f"bind('f', async d => {{ const r = await api('/authorize/login', {{request_id: {rid}, login: d.login, password: d.password}}); "
              f"if (r.verify_needed) location.reload(); else location.href = r.redirect; }});")
    return auth(f"Sign in to {client['name']}", "Use your Gamma Cloud account.", inner, script)
