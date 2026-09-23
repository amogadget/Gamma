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
import re
from datetime import datetime, timezone

from . import accounts, config
from .providers import NAMES

SITE = "https://gammapdf.com"
NO_STORE = {"Cache-Control": "no-store"}
USERNAME_PATTERN = accounts.USERNAME_RE.pattern.strip("^$")   # the <input pattern> of every username field

LOGO = ('<svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
        '<rect width="32" height="32" rx="7" fill="#1e1e1c"/>'
        '<path d="M 6 16 C 9 10.5 13 10.5 16 16 C 19 21.5 23 21.5 26 16" stroke="#e8a020" stroke-width="1.2" fill="none" opacity="0.6" stroke-linecap="round"/>'
        '<path d="M 6 16 C 9 21.5 13 21.5 16 16 C 19 10.5 23 10.5 26 16" stroke="#e8a020" stroke-width="1.2" fill="none" opacity="0.6" stroke-linecap="round"/>'
        '<path d="M 6 4 Q 2 16 6 28" stroke="#e8a020" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.9"/>'
        '<path d="M 26 4 Q 30 16 26 28" stroke="#e8a020" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.9"/>'
        '<rect x="9" y="8" width="13" height="3" rx="0.8" fill="#eeebe4"/><rect x="9" y="8" width="3" height="15" rx="0.8" fill="#eeebe4"/></svg>')

CSS = """
:root{--bg:#f7f6f3;--surface:#fff;--surface-2:#f1efea;--text:#1f1e1b;--text-2:#5f5c55;--muted:#8a877e;--line:#e6e3db;--line-2:#d9d5cb;--accent:#e8a020;--accent-ink:#9a6206;--accent-soft:#faf0d9;--primary:#1e1e1c;--primary-fg:#eeebe4;--primary-hover:#31312e;--danger:#b3261e;--danger-soft:#fbe9e7;--ok:#2f7a3d;--ok-soft:#e3f2e5;--font:Inter,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace;color-scheme:light}
@media(prefers-color-scheme:dark){:root{--bg:#191918;--surface:#202020;--surface-2:#262625;--text:#ecebe6;--text-2:#b5b2a9;--muted:#85827a;--line:#2f2f2c;--line-2:#3b3b37;--accent-ink:#f0b74a;--accent-soft:#3a301d;--primary:#e8a020;--primary-fg:#1a1a18;--primary-hover:#f0b03a;--danger:#e5766d;--danger-soft:#3a2422;--ok:#7fc98d;--ok-soft:#1e3122;color-scheme:dark}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased;min-height:100vh}
a{color:var(--accent-ink);text-decoration:none}a:hover{text-decoration:underline}h1,h2,h3{margin:0;line-height:1.2;letter-spacing:-.01em;font-weight:600}h1{font-size:24px}h2{font-size:15px}p{margin:0}code{font-family:var(--mono);font-size:12.5px;background:var(--surface-2);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 12px;border-radius:6px;font:inherit;font-weight:500;font-size:14px;line-height:1.2;border:1px solid var(--line-2);background:var(--surface);color:var(--text);white-space:nowrap;cursor:pointer;text-decoration:none;transition:background-color .1s,border-color .1s}
.btn:hover{background:var(--surface-2);text-decoration:none}.btn:disabled{opacity:.5;cursor:default}
.btn--primary{background:var(--primary);color:var(--primary-fg);border-color:var(--primary)}.btn--primary:hover{background:var(--primary-hover)}
.btn--danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,var(--line-2))}.btn--danger:hover{background:var(--danger-soft)}
.btn--sm{padding:4px 9px;font-size:13px}.btn--block{width:100%;padding:9px 12px}
label{display:block;font-size:12.5px;font-weight:500;color:var(--text-2);margin:12px 0 5px}label small{font-weight:400;color:var(--muted)}
input,select{width:100%;padding:8px 10px;border:1px solid var(--line-2);border-radius:6px;background:var(--surface);color:inherit;font:inherit;font-size:14px}input:focus,select:focus{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:0;border-color:var(--accent)}
form .btn{margin-top:14px}.cf-turnstile{margin-top:14px}.msg{min-height:1.3em;font-size:13px;margin-top:8px;color:var(--danger)}.msg.ok{color:var(--ok)}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:500;padding:2px 8px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);color:var(--text-2);white-space:nowrap}
.pill--ok{background:var(--ok-soft);color:var(--ok);border-color:transparent}.pill--warn{background:var(--accent-soft);color:var(--accent-ink);border-color:transparent}
/* auth shell */
.authwrap{min-height:100vh;display:flex;flex-direction:column}.authtop{display:flex;align-items:center;gap:10px;padding:18px 24px;font-weight:600;color:var(--text)}.authtop a{color:inherit}.authtop svg{display:block}.authtop em{font-style:normal;color:var(--accent);font-weight:500;margin-left:3px}
.auth{margin:6vh auto 40px;width:min(400px,100% - 32px)}.auth h1{font-size:22px;margin-bottom:6px}.auth .lead{color:var(--text-2);margin-bottom:18px;font-size:14px}.auth .links{margin-top:16px;font-size:13px;color:var(--text-2);display:flex;gap:14px;flex-wrap:wrap}
.card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:22px}
.fieldhead{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:12px 0 5px}.fieldhead label{margin:0}.fieldhead a{font-size:12.5px}
.or{display:flex;align-items:center;gap:12px;margin:20px 0 14px;color:var(--muted);font-size:12.5px}.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}
.providers{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}
.provider{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:14px 8px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-weight:500;cursor:pointer;transition:background-color .1s,border-color .1s}
.provider:hover{background:var(--surface-2)}.provider:disabled{opacity:.6;cursor:default}.provider svg{width:20px;height:20px}
.switch{margin-top:18px;text-align:center;font-size:13.5px;color:var(--text-2)}.terms{margin-top:12px;text-align:center;font-size:12px;color:var(--muted)}.terms a{color:inherit;text-decoration:underline}
.via{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface-2);font-size:13.5px}.via svg{width:18px;height:18px;flex:none}
.conn{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.conn:first-child{border-top:0;padding-top:0}.conn>svg{width:18px;height:18px;flex:none}.conn .txt{flex:1;min-width:0}.conn .txt b{font-weight:500;display:block}.conn .txt span{color:var(--muted);font-size:12.5px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* app shell */
.app{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.side{background:var(--surface-2);border-right:1px solid var(--line);padding:14px 10px;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow-y:auto}
.side .brand{display:flex;align-items:center;gap:9px;padding:6px 8px 16px;font-weight:600;font-size:15px;color:var(--text)}.side .brand em{font-style:normal;color:var(--accent);font-weight:500;margin-left:3px}.side .brand:hover{text-decoration:none}
.side a.item,.side button.item{display:flex;align-items:center;gap:10px;padding:7px 9px;border-radius:6px;color:var(--text-2);font:inherit;font-weight:500;background:none;border:0;text-align:left;cursor:pointer;width:100%}
.side .item:hover{background:color-mix(in srgb,var(--text) 6%,transparent);text-decoration:none;color:var(--text)}
.side .item.on{background:var(--surface);color:var(--text);box-shadow:0 0 0 1px var(--line),0 1px 2px rgb(0 0 0/.04)}.side .item.on svg{color:var(--accent-ink);opacity:1}
.side .item svg{width:16px;height:16px;flex:none;opacity:.75}.side .item .ext{margin-left:auto;width:12px;height:12px;opacity:.45}.side .grow{flex:1}.side .label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:14px 9px 4px}
.side .me{display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;margin-top:6px;font-size:13px;color:var(--text)}.side .me:hover{background:color-mix(in srgb,var(--text) 6%,transparent);text-decoration:none}.side .me .avatar{width:30px;height:30px;font-size:13px}.side .me div{min-width:0}.side .me b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.side .me span{color:var(--muted);font-size:12px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avatar{width:32px;height:32px;border-radius:50%;background:var(--accent-soft);color:var(--accent-ink);font-weight:600;display:grid;place-items:center;text-transform:uppercase;flex:none}
.main{padding:40px 48px 64px;max-width:1040px;width:100%}.pagehead{margin-bottom:24px}.pagehead p{color:var(--text-2);margin-top:6px}
.hello{display:flex;align-items:center;gap:16px;margin-bottom:24px}.hello .avatar{width:52px;height:52px;font-size:21px}.hello p{color:var(--text-2);margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cols{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:16px;align-items:start}.cols>div>.section:last-child{margin-bottom:0}.cols{margin-bottom:16px}
.section>h2 a{font-weight:500;font-size:13px}.section>.list{padding:0}
.steps{list-style:none;margin:0;padding:0}.step{display:flex;align-items:center;gap:14px;padding:13px 16px;border-top:1px solid var(--line)}.step:first-child{border-top:0}
.step .dot{width:26px;height:26px;border-radius:50%;border:1.5px solid var(--line-2);display:grid;place-items:center;font-size:12px;font-weight:600;color:var(--muted);flex:none}.step .dot svg{width:14px;height:14px}
.step.done .dot{background:var(--ok);border-color:var(--ok);color:var(--surface)}.step.done b{color:var(--text-2);font-weight:500}.step .txt{flex:1;min-width:0}.step .txt b{font-weight:600}.step .txt span{display:block;color:var(--muted);font-size:12.5px}
.progress{display:flex;align-items:center;gap:10px;font-weight:400;font-size:12.5px;color:var(--muted)}.progress i{display:block;width:96px;height:6px;border-radius:99px;background:var(--surface-2);overflow:hidden}.progress i b{display:block;height:100%;background:var(--accent);border-radius:99px}
.dev{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--line)}.dev:first-child{border-top:0}
.dev .ico{width:36px;height:36px;border-radius:8px;background:var(--surface-2);border:1px solid var(--line);display:grid;place-items:center;color:var(--text-2);flex:none}.dev .ico svg{width:18px;height:18px}
.dev .txt{flex:1;min-width:0}.dev .txt b{font-weight:500;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dev .txt span{color:var(--muted);font-size:12.5px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dev .when{color:var(--muted);font-size:12.5px;white-space:nowrap}.dev .when.live{color:var(--ok)}.dev .when.live::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;margin-right:6px;vertical-align:1px}
.blank{padding:28px 20px;text-align:center;color:var(--text-2);font-size:13.5px}.blank svg{width:28px;height:28px;color:var(--muted);display:block;margin:0 auto 10px}.blank .actions{justify-content:center}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:11px 16px;font-size:13.5px;margin:0}.kv dt{color:var(--muted)}.kv dd{margin:0;text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.copy{background:none;border:0;color:var(--muted);cursor:pointer;padding:0 0 0 6px;font:inherit;font-size:12px}.copy:hover{color:var(--text)}
.planname{font-size:20px;font-weight:600;text-transform:capitalize;margin-bottom:6px;display:flex;align-items:center;gap:8px}.plantext{color:var(--text-2);font-size:13.5px}
.srow{display:grid;grid-template-columns:230px minmax(0,1fr);gap:24px;padding:20px;border-top:1px solid var(--line)}.srow:first-child{border-top:0}
.srow .desc b{display:block;font-weight:600}.srow .desc span{display:block;color:var(--muted);font-size:12.5px;margin-top:3px}
.srow form>label:first-child,.srow .fields label{margin-top:0}.srow .fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.srow .fields+.fields{margin-top:12px}.current{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-weight:500}
.formfoot{display:flex;align-items:center;gap:12px;margin-top:14px;flex-wrap:wrap}form .formfoot .btn{margin:0}.formfoot .msg{margin:0;min-height:0}
.reveal[hidden]{display:none}.section>h2+.srow{border-top:0}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.section{background:var(--surface);border:1px solid var(--line);border-radius:8px;margin-bottom:16px}.section>h2{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px}.section>h2 span{font-weight:400;color:var(--muted);font-size:13px}.section>.body{padding:14px 16px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.row:first-child{border-top:0}.row .sub{color:var(--muted);font-size:12px;display:block}.row b{font-weight:500}
.notice{background:var(--accent-soft);color:var(--accent-ink);border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);border-radius:8px;padding:10px 14px;font-size:13.5px;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.empty{color:var(--text-2);font-size:13.5px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.actions .btn{margin-top:0}
.danger{border-color:color-mix(in srgb,var(--danger) 35%,var(--line))}.danger>h2{color:var(--danger)}
form.inline{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}form.inline label{margin:0;flex:1;min-width:120px}form.inline .btn{margin:0}
.section>.body.tbl{padding:0}table{width:100%;border-collapse:collapse;font-size:13.5px}th{text-align:left;color:var(--muted);font-weight:500;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line)}td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}tr:last-child td{border-bottom:0}td .btn{margin:0}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:16px}.tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:8px 12px;font:inherit;font-weight:500;color:var(--text-2);cursor:pointer;margin-bottom:-1px}.tabs button.on{color:var(--text);border-bottom-color:var(--text)}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}.toolbar input{max-width:320px}.toolbar .spacer{flex:1}
select.sm{width:auto;padding:3px 6px;font-size:13px}.mono{font-family:var(--mono);font-size:12px}
.secretbox{background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);border-radius:6px;padding:10px 12px;margin-top:10px;font-family:var(--mono);font-size:12.5px;word-break:break-all;white-space:pre-wrap}
.notice svg{width:16px;height:16px;flex:none;margin-right:8px;vertical-align:-3px}
@media(max-width:820px){.app{grid-template-columns:minmax(0,1fr);align-content:start}.dev{flex-wrap:wrap;row-gap:6px}.dev .ico{display:none}.dev .txt{flex-basis:100%}.dev .txt span{white-space:normal}.dev .when{margin-right:auto}.side{position:sticky;top:0;z-index:5;height:auto;flex-direction:row;align-items:center;gap:2px;padding:8px 12px;border-right:0;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}.side::-webkit-scrollbar{display:none}.side .brand{padding:4px 8px 4px 0}.side .brand .bw,.side .label,.side .me,.side .grow,.side .gl{display:none}.side a.item,.side button.item{width:auto;white-space:nowrap;padding:6px 10px}.main{padding:24px 16px 48px}.cols{grid-template-columns:1fr}.srow{grid-template-columns:1fr;gap:12px;padding:16px}.srow .fields{grid-template-columns:1fr}.hello .avatar{width:44px;height:44px;font-size:18px}.hello h1{font-size:21px}}
"""

JS = """
async function api(path, body, method){
  let r;
  try { r = await fetch(path, {method: method || 'POST', headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin'}); }
  catch (e) { throw new Error('Cannot reach Gamma Cloud. Check the connection and try again.'); }
  let data = {}; try { data = await r.json(); } catch (e) {}
  if (!r.ok) { const err = new Error(data.detail || ('Request failed (' + r.status + ')')); err.status = r.status; throw err; }
  return data;
}
// A button's action: disabled while it runs; a failure is shown in msg (else an alert) and the
// button comes back; a lost session goes to the sign-in page and returns here.
async function act(btn, fn, msg){
  btn.disabled = true; if (msg) { msg.textContent = ''; msg.classList.remove('ok'); }
  try { await fn(); }
  catch (e) {
    if (e.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
    if (msg) msg.textContent = e.message; else alert(e.message);
    btn.disabled = false;
  }
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
// The Google / GitHub buttons ([data-provider]) and Google's one-tap prompt; o is _social() in pages.py.
function social(o){
  const msg = document.getElementById('smsg'), fail = (e) => { if (msg) msg.textContent = e.message; };
  document.querySelectorAll('[data-provider]').forEach(b => b.onclick = async () => {
    if (msg) msg.textContent = ''; b.disabled = true;
    try { const d = await api('/api/oauth/' + b.dataset.provider + '/start', {next: o.next || '/', request_id: o.request_id || '', link: !!o.link}); location.href = d.url; }
    catch (e) { fail(e); b.disabled = false; }
  });
  if (!o.tap) return;
  const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({client_id: o.tap.client_id, nonce: o.tap.nonce, context: o.tap.context || 'signin',
      auto_select: false, cancel_on_tap_outside: false, itp_support: true, use_fedcm_for_prompt: true,
      callback: async r => { try { const d = await api('/api/oauth/google/one-tap', {credential: r.credential, next: o.next || '/', request_id: o.request_id || ''}); location.href = d.redirect; } catch (e) { fail(e); } }});
    google.accounts.id.prompt();
  };
  document.head.appendChild(s);
}
const out = document.getElementById('signout'); if (out) out.onclick = (e) => { e.preventDefault(); act(out, async () => { await api('/api/logout', {}); location.href = '/login'; }); };
// Dates and "last active" tooltips in the viewer's own time zone (the server writes UTC).
document.querySelectorAll('time[datetime]').forEach(t => { const d = new Date(t.dateTime); if (!isNaN(d)) t.textContent = d.toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'}); });
document.querySelectorAll('[data-at]').forEach(e => { const d = new Date(e.dataset.at); if (!isNaN(d)) e.title = e.dataset.label + ' ' + d.toLocaleString(); });
"""

ICONS = {
    "home": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z"/></svg>',
    "devices": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    "settings": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    "admin": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    "download": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
    "docs": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5z"/></svg>',
    "desktop": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg>',
    "globe": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    "check": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
    "mail": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    "ext": '<svg class=ext viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M8 7h9v9"/></svg>',
    "google": '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
    "github": '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
    "out": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
}


def esc(value) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def _js(value) -> str:
    """A value as a JS literal inside an inline <script>."""
    return json.dumps(value).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


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


def app(title: str, lead: str, account: dict, active: str, inner: str, script: str = "", head: str = "") -> str:
    """The signed-in shell. ``head`` replaces the default title + lead block
    (the Overview's greeting)."""
    def item(key, href, label):
        return f"<a class='item {'on' if key == active else ''}' href='{href}'>{ICONS[key]}{label}</a>"
    nav = item("home", "/", "Overview") + item("devices", "/devices", "Devices") + item("settings", "/settings", "Settings")
    if account["is_admin"]:
        nav += "<div class=label>Server</div>" + item("admin", "/admin", "Admin")
    nav += ("<div class='label gl'>Gamma</div>"
            f"<a class='item gl' href='{SITE}/download'>{ICONS['download']}Download the app{ICONS['ext']}</a>"
            f"<a class='item gl' href='{SITE}/docs'>{ICONS['docs']}Docs{ICONS['ext']}</a>")
    name = account.get("display_name") or account["username"]
    side = (f"<aside class=side><a class=brand href='/'>{LOGO}<span class=bw>Gamma<em>Cloud</em></span></a>{nav}<div class=grow></div>"
            f"<button class=item id=signout>{ICONS['out']}Sign out</button>"
            f"<a class=me href='/settings' title='Settings'><div class=avatar>{esc(name[:1])}</div>"
            f"<div><b>{esc(name)}</b><span>{esc(account['email'])}</span></div></a></aside>")
    head = head or f"<header class=pagehead><h1>{esc(title)}</h1>" + (f"<p>{lead}</p>" if lead else "") + "</header>"
    return (_head(title) + f"<body><div class=app>{side}<main class=main>{head}{inner}</main></div>"
            f"<script>{JS}{script}</script></body></html>")


def turnstile_widget() -> str:
    if not config.TURNSTILE_SITEKEY:
        return ""
    return f'<div class="cf-turnstile" data-sitekey="{esc(config.TURNSTILE_SITEKEY)}"></div>'


def error_page(title: str, message: str, back: str = "/") -> str:
    return auth(title, esc(message), f"<p class=links><a href='{esc(back)}'>Back</a></p>")


def _social(social: dict | None, verb: str = "continue", context: str = "signin") -> tuple[str, str]:
    """(HTML, script) for the Google / GitHub tiles under a sign-in form and
    Google's one-tap prompt; ``social`` comes from ``external.sign_in_page``."""
    if not social or not social["providers"]:
        return "", ""
    tiles = "".join(f"<button type=button class=provider data-provider={p}>{ICONS[p]}<span>{NAMES[p]}</span></button>"
                    for p in social["providers"])
    opts = {**social, "tap": {**social["tap"], "context": context} if social.get("tap") else None}
    return (f"<div class=or>or {verb} with</div><div class=providers>{tiles}</div><div class=msg id=smsg></div>",
            f"social({_js(opts)});")


def _password_fields() -> str:
    return ("<label>E-mail or username<input name=login autocomplete=username required autofocus></label>"
            "<div class=fieldhead><label for=password>Password</label><a href=/reset>Forgot password?</a></div>"
            "<input id=password name=password type=password autocomplete=current-password required>"
            "<button type=submit class='btn btn--primary btn--block'>Sign in</button><div class=msg></div>")


def _to_register() -> str:
    return ("<p class=switch>New to Gamma Cloud? <a href=/register>Create an account</a></p>"
            if config.REGISTRATION != "closed" else "")


def _terms() -> str:
    return f"<p class=terms>By continuing you agree to the <a href='{SITE}/privacy/'>privacy policy</a>.</p>"


def _invite_field() -> str:
    return "<label>Invite code<input name=invite required autocomplete=off></label>" if config.REGISTRATION == "invite" else ""


# --- auth pages ---------------------------------------------------------------

def login_page(social: dict | None = None) -> str:
    tiles, script = _social(social)
    next_url = (social or {}).get("next", "/")
    inner = f"<form id=f>{_password_fields()}</form>{tiles}{_to_register()}{_terms()}"
    script = f"bind('f', async d => {{ await api('/api/login', d); location.href = {_js(next_url)}; }});" + script
    return auth("Sign in", "One account for the desktop app and every Gamma server.", inner, script)


def register_page(social: dict | None = None) -> str:
    if config.REGISTRATION == "closed":
        return error_page("Registration is closed", "Gamma Cloud is not taking new accounts right now.")
    tiles, script = _social(social, "sign up", "signup")
    inner = ("<form id=f><label>E-mail<input name=email type=email autocomplete=email required autofocus></label>"
             "<label>Username <small>lowercase letters, digits, hyphens</small><input name=username autocomplete=username "
             f"pattern='{USERNAME_PATTERN}' required></label>"
             "<label>Password<input name=password type=password autocomplete=new-password minlength=8 required></label>"
             f"{_invite_field()}{turnstile_widget()}<button type=submit class='btn btn--primary btn--block'>Create account</button><div class=msg></div></form>"
             f"{tiles}<p class=switch>Already have an account? <a href=/login>Sign in</a></p>{_terms()}")
    script = "bind('f', async d => { const r = await api('/api/register', d); location.href = r.mailed === false ? '/?mail=failed' : '/'; });" + script
    return auth("Create your account", "Free. You can change the username and e-mail later.", inner, script)


def signup_finish_page(flow: dict, suggestion: str) -> str:
    """After Google/GitHub for a new person: pick the username (and give the
    invite code in ``invite`` mode)."""
    p = flow["provider"]
    inner = (f"<div class=via>{ICONS[p]}<span>{NAMES[p]} · <b>{esc(flow['email'])}</b></span></div>"
             "<form id=f><label>Username <small>your name on every Gamma server</small><input name=username "
             f"value='{esc(suggestion)}' autocomplete=username pattern='{USERNAME_PATTERN}' required autofocus></label>"
             f"{_invite_field()}<button type=submit class='btn btn--primary btn--block'>Create account</button><div class=msg></div></form>"
             f"<p class=switch><a href=/login>Cancel</a></p>{_terms()}")
    script = "bind('f', async d => { const r = await api('/api/oauth/signup', d); location.href = r.redirect; });"
    hello = f"Welcome, {esc(flow['name'])}. " if flow.get("name") else ""
    return auth("Finish creating your account", hello + "Pick a username; you can change it later.", inner, script)


def _token_page(title: str, api_path: str, token: str, done_js: str) -> str:
    """A mailed link's landing page: posts the token, shows ``done_js`` (a
    JS expression over the answer ``d``), then goes to the Overview."""
    script = (f"api({_js(api_path)}, {{token: {_js(token)}}}).then(d => {{ document.getElementById('msg').textContent = "
              f"{done_js}; setTimeout(() => location.href = '/', 1200); }})"
              f".catch(e => {{ document.getElementById('msg').textContent = e.message; }});")
    return auth(title, "One moment.", "<p id=msg class=msg></p><p class=links><a href='/'>Overview</a></p>", script)


def verify_page(token: str) -> str:
    return _token_page("Confirming your e-mail", "/api/verify", token,
                       "'Your e-mail address is confirmed. Taking you to your account…'")


def email_confirm_page(token: str) -> str:
    return _token_page("Changing your e-mail", "/api/email/confirm", token, "'Your e-mail address is now ' + d.email + '.'")


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

def _when(iso: str) -> datetime | None:
    try:
        return datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def _day(iso: str) -> str:
    t = _when(iso)
    return f"{t.day} {t:%b %Y}" if t else iso


def _date(iso: str) -> str:
    """A date as HTML; the page's script shows it in the viewer's time zone."""
    return f"<time datetime='{esc(iso)}'>{esc(_day(iso))}</time>"


def _ago(iso: str) -> str:
    """"Active now", "3 hours ago", "Yesterday", "12 days ago"; "" after a
    month (the caller shows the date)."""
    t = _when(iso)
    if not t:
        return ""
    secs = (datetime.now(timezone.utc) - t).total_seconds()
    if secs < 600:
        return "Active now"
    if secs < 3600:
        return f"{int(secs // 60)} minutes ago"
    if secs < 86400:
        n = int(secs // 3600)
        return "1 hour ago" if n == 1 else f"{n} hours ago"
    days = int(secs // 86400)
    if days == 1:
        return "Yesterday"
    return f"{days} days ago" if days < 30 else ""


def _platform(ua: str) -> str:
    """A readable "Windows · Gamma 0.9.4" / "macOS · Safari" from a user
    agent; a Gamma server names its system as ``Gamma/<version> (<system>; …)``."""
    ua = ua or ""
    os_name = next((n for k, n in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"),
                                   ("Macintosh", "macOS"), ("macOS", "macOS"), ("CrOS", "ChromeOS"), ("Linux", "Linux"))
                    if k in ua), "")
    m = re.search(r"Gamma/([\d.]+)", ua)
    if m:
        client = f"Gamma {m.group(1)}"
    else:
        client = next((n for k, n in (("Edg/", "Edge"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari"))
                       if k in ua), "")
        if not client and not os_name:
            client = ua[:40]
    return " · ".join(x for x in (os_name, client) if x)


def _last(iso: str, label: str) -> str:
    """The relative time at a row's end; its tooltip is the exact time."""
    ago = _ago(iso)
    return (f"<span class='when{' live' if ago == 'Active now' else ''}' data-at='{esc(iso)}' data-label='{label}' "
            f"title='{label} {esc(iso[:16].replace('T', ' '))} UTC'>{esc(ago) if ago else _date(iso)}</span>")


def _row(icon: str, title: str, meta: list[str], end: str) -> str:
    """A Devices row; ``meta`` holds HTML pieces, joined by middots."""
    return (f"<div class=dev><div class=ico>{ICONS[icon]}</div><div class=txt><b>{esc(title)}</b>"
            f"<span>{' · '.join(x for x in meta if x) or '&nbsp;'}</span></div>{end}</div>")


def _app_row(d: dict, manage: bool) -> str:
    """One signed-in Gamma app, named after its machine when it said;
    ``manage`` adds the details and the sign-out button."""
    title = d.get("device_name") or d["client"]
    meta = [esc(d["client"]) if d.get("device_name") else "", esc(_platform(d.get("user_agent")))]
    end = _last(d["last_used_at"], "Last active")
    if manage:
        meta += [f"signed in {_date(d['created_at'])}", f"last seen at {esc(d['ip'])}" if d.get("ip") else ""]
        end += f"<button class='btn btn--sm' data-revoke='{esc(d['id'])}' aria-label='Sign out {esc(title)}'>Sign out</button>"
    return _row("desktop", title, meta, end)


def _browser_row(b: dict) -> str:
    title = _platform(b["user_agent"]) or "Unknown browser"
    meta = [f"signed in {_date(b['created_at'])}", f"last seen at {esc(b['ip'])}" if b["ip"] else ""]
    end = ("<span class='pill pill--ok'>This browser</span>" if b["current"] else
           _last(b["last_seen_at"], "Last seen")
           + f"<button class='btn btn--sm' data-endsession='{esc(b['id'])}' aria-label='Sign out {esc(title)}'>Sign out</button>")
    return _row("globe", title, meta, end)


def _email_pill(account: dict) -> str:
    return ("<span class='pill pill--ok'>confirmed</span>" if account["email_verified"]
            else "<span class='pill pill--warn'>not confirmed</span>")


def _notice(account: dict, mail_failed: bool = False) -> str:
    if account["email_verified"]:
        return ""
    text = ("We could not send the confirmation mail. Try again in a few minutes." if mail_failed else
            "Gamma servers will not sign you in until you open the link we mailed you.")
    return (f"<div class=notice><span>{ICONS['mail']}<b>Your e-mail is not confirmed yet.</b> {text}</span>"
            "<button class='btn btn--sm' data-resend>Resend the mail</button></div>")


RESEND_JS = ("document.querySelectorAll('[data-resend]').forEach(r => r.onclick = async () => { r.disabled = true; "
             "try { await api('/api/verify/resend', {}); r.textContent = 'Sent — check your inbox'; } "
             "catch (e) { r.textContent = e.message; r.disabled = false; } });")


def overview_page(account: dict, devices: list[dict], mail_failed: bool = False) -> str:
    verified = account["email_verified"]
    name = account["display_name"] or account["username"]
    tags = (f"<span>@{esc(account['username'])}</span><span class=pill>{esc(account['plan'].capitalize())} plan</span>"
            + ("<span class=pill>Admin</span>" if account["is_admin"] else ""))
    head = (f"<header class=hello><div class=avatar>{esc(name[:1])}</div><div><h1>Welcome back, {esc(name)}</h1>"
            f"<p>{tags}</p></div></header>")

    # the setup checklist: shown until every step is done
    def step(done, title, sub, action):
        return (f"<li class='step{' done' if done else ''}'><span class=dot>{ICONS['check'] if done else ''}</span>"
                f"<span class=txt><b>{title}</b><span>{sub}</span></span>{'' if done else action}</li>")
    signed_in = account["app_signed_in"] or bool(devices)
    done = 1 + verified + signed_in
    setup = "" if done == 3 else (
        f"<section class=section><h2>Get started <span class=progress>{done} of 3<i><b style='width:{done * 100 // 3}%'></b></i></span></h2>"
        "<ul class=steps>"
        + step(True, "Create your account", f"Member since {_date(account['created_at'])}", "")
        + step(verified, "Confirm your e-mail", "Gamma servers accept this account." if verified
               else f"We sent a link to {esc(account['email'])}.", "<button class='btn btn--sm' data-resend>Resend</button>")
        + step(signed_in, "Sign in from the Gamma app", "Done." if signed_in
               else "Install the desktop app and choose <b>Sign in with Gamma Cloud</b>.",
               f"<a class='btn btn--primary btn--sm' href='{SITE}/download'>Download</a>")
        + "</ul></section>")

    recent = "".join(_app_row(d, False) for d in devices[:4]) or (
        f"<div class=blank>{ICONS['devices']}{'No Gamma app is signed in right now.' if signed_in else 'Nothing has signed in with this account yet.'}"
        f"<div class=actions><a class='btn btn--sm' href='{SITE}/download'>Get the desktop app</a></div></div>")
    more = f"<a href='/devices'>Manage{f' all {len(devices)}' if len(devices) > 4 else ''}</a>"
    signins = f"<section class=section><h2>Gamma apps <span>{more}</span></h2><div class=list>{recent}</div></section>"
    plan = (f"<section class=section><h2>Plan</h2><div class=body><div class=planname>{esc(account['plan'])}</div>"
            "<p class=plantext>The desktop app is your library. A hosted Gamma server of your own comes with the Plus and Pro plans.</p>"
            f"<div class=actions><a class='btn btn--sm' href='{SITE}/#selfhost'>Self-host instead</a></div></div></section>")
    who = (f"<section class=section><h2>Account <span><a href='/settings'>Edit</a></span></h2><div class=body><dl class=kv>"
           f"<dt>Username</dt><dd title='Your name on every Gamma server'>{esc(account['username'])}</dd>"
           f"<dt>E-mail</dt><dd title='{esc(account['email'])}'>{_email_pill(account)}</dd>"
           f"<dt>Member since</dt><dd>{_date(account['created_at'])}</dd>"
           f"<dt title='What servers key on; never changes'>Account id</dt><dd><span class=mono>{esc(account['id'])}</span>"
           f"<button class=copy data-copy='{esc(account['id'])}'>Copy</button></dd></dl></div></section>")
    inner = _notice(account, mail_failed) + setup + f"<div class=cols><div>{signins}</div><div>{plan}{who}</div></div>"
    script = RESEND_JS + ("document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { "
                          "await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; "
                          "setTimeout(() => b.textContent = 'Copy', 1200); });")
    return app("Overview", "", account, "home", inner, script, head)


def devices_page(account: dict, devices: list[dict], browsers: list[dict]) -> str:
    empty = (f"<div class=blank>{ICONS['devices']}No Gamma app is signed in with this account.<br>"
             "Choose <b>Sign in with Gamma Cloud</b> in the desktop app and it shows up here.</div>")
    apps = "".join(_app_row(d, True) for d in devices) or empty
    rows = "".join(_browser_row(b) for b in sorted(browsers, key=lambda b: not b["current"]))
    others = devices or any(not b["current"] for b in browsers)
    everywhere = "<button class='btn btn--sm btn--danger' id=revokeall>Sign out everywhere else</button>" if others else ""
    inner = (f"<section class=section><h2>Gamma apps <span data-count>{len(devices)} signed in</span></h2>"
             f"<div class=list data-empty='{esc(empty)}'>{apps}</div></section>"
             f"<section class=section><h2>Browsers <span data-count>{len(browsers)} signed in</span></h2>"
             f"<div class=list>{rows}</div></section>"
             f"<div class=formfoot>{everywhere}<span class=empty>Signing an app out revokes its key to this account, so it "
             "cannot renew its sign-in. Sessions it already opened on its own Gamma server stay open until you sign out "
             "there.</span></div><div class=msg id=devmsg></div>")
    script = """
const msg = document.getElementById('devmsg');
function gone(row){
  const list = row.parentElement; row.remove();
  const n = list.querySelectorAll('.dev').length;
  list.closest('.section').querySelector('[data-count]').textContent = n + ' signed in';
  if (!n && list.dataset.empty) list.innerHTML = list.dataset.empty;
}
document.querySelectorAll('[data-revoke]').forEach(b => b.onclick = () => act(b, async () => {
  await api('/api/devices/' + b.dataset.revoke + '/revoke', {}); gone(b.closest('.dev')); }, msg));
document.querySelectorAll('[data-endsession]').forEach(b => b.onclick = () => act(b, async () => {
  await api('/api/sessions/' + b.dataset.endsession + '/revoke', {}); gone(b.closest('.dev')); }, msg));
const all = document.getElementById('revokeall');
if (all) all.onclick = () => {
  if (!confirm('Sign out every Gamma app and every other browser? Apps keep the sessions they already opened on their own Gamma server.')) return;
  act(all, async () => { await api('/api/devices/revoke-all', {}); location.reload(); }, msg);
};
"""
    return app("Devices", "Where this account is signed in. Sign out anything you do not recognise.",
               account, "devices", inner, script)


def _connections(linked: list[dict], enabled: list[str]) -> str:
    """The Connected accounts rows: every provider offered or linked."""
    by = {i["provider"]: i for i in linked}
    rows = ""
    for p in dict.fromkeys([*enabled, *by]):
        if p not in NAMES:
            continue
        i = by.get(p)
        btn = (f"<button class='btn btn--sm' data-unlink={p}>Disconnect</button>" if i
               else f"<button class='btn btn--sm' data-provider={p}>Connect</button>" if p in enabled else "")
        sub = f"Connected as {esc(i['email'])}" if i else "Not connected"
        rows += f"<div class=conn>{ICONS[p]}<div class=txt><b>{NAMES[p]}</b><span>{sub}</span></div>{btn}</div>"
    return rows


def settings_page(account: dict, linked: list[dict] | None = None, enabled: list[str] | None = None) -> str:
    def row(title, sub, body):
        return f"<div class=srow><div class=desc><b>{title}</b><span>{sub}</span></div><div>{body}</div></div>"

    def foot(label, cls=""):
        return f"<div class=formfoot><button type=submit class='btn btn--sm {cls}'>{label}</button><div class=msg></div></div>"
    # the password a change needs appears once the field above it is edited
    # (``data-gated``); an account without one confirms with its session
    has_pw = account["has_password"]
    pw = ("<label>Password <small>to confirm it is you</small>"
          "<input name=password type=password autocomplete=current-password required></label>") if has_pw else ""
    profile = (
        row("Display name", "Shown on Gamma servers next to your username.",
            f"<form id=name><label><span class=sr>Display name</span><input name=display_name value='{esc(account['display_name'])}' maxlength=100 "
            f"placeholder='{esc(account['username'])}'></label>{foot('Save')}</form>")
        + row("Username", "Your name on every Gamma server: lowercase letters, digits and hyphens.",
              f"<form id=user data-gated><label><span class=sr>Username</span><input name=username value='{esc(account['username'])}' "
              f"pattern='{USERNAME_PATTERN}' required></label><div class=reveal hidden>{pw}</div>"
              f"{foot('Change username')}</form>"))
    email = row("E-mail address", "A confirmation link goes to the new address; the current one stays until you open it.",
                f"<div class=current>{esc(account['email'])} {_email_pill(account)}</div>"
                "<form id=em data-gated><label>New address<input name=new_email type=email placeholder='name@example.org' required></label>"
                f"<div class=reveal hidden>{pw}</div>{foot('Send confirmation')}</form>")
    new_pw = ("<label>New password <small>8+ characters</small>"
              "<input name=new type=password autocomplete=new-password minlength=8 required></label>")
    if has_pw:
        password = row("Password", "Changing it signs out every other browser and device.",
                       "<form id=pw><div class=fields><label>Current password<input name=current type=password "
                       f"autocomplete=current-password required></label>{new_pw}</div>{foot('Change password')}</form>")
    else:
        password = row("Password", "You sign in with a connected account. A password lets you sign in with your "
                       "e-mail or username too.", f"<form id=pw><div class=fields>{new_pw}</div>{foot('Set password')}</form>")
    conns = _connections(linked or [], enabled or [])
    connected = row("Connected accounts", "Sign in with one click instead of a password.",
                    f"{conns}<div class=msg id=smsg></div>") if conns else ""
    delete = row("Delete account", "Signs everything out and removes the account after a grace period. Gamma servers keep their data.",
                 "<button class='btn btn--sm btn--danger' id=delopen>Delete my account…</button>"
                 f"<form id=del class=reveal hidden>{pw}{foot('Delete my account', 'btn--danger')}</form>")
    inner = (_notice(account)
             + f"<section class=section><h2>Profile</h2>{profile}</section>"
             + f"<section class=section><h2>Sign-in</h2>{email}{connected}{password}</section>"
             + f"<section class='section danger'><h2>Danger zone</h2>{delete}</section>")
    script = RESEND_JS + """
document.querySelectorAll('form[data-gated]').forEach(f => {
  const inp = f.querySelector('input'), rev = f.querySelector('.reveal'), btn = f.querySelector('button[type=submit]'), orig = inp.value;
  const sync = () => { const v = inp.value.trim(), changed = v !== '' && v !== orig; rev.hidden = !changed; btn.disabled = !changed; };
  inp.addEventListener('input', sync); sync();
});
document.getElementById('delopen').onclick = (e) => { e.target.hidden = true; const f = document.getElementById('del'); f.hidden = false; const i = f.querySelector('input'); if (i) i.focus(); };
social({link: true});
document.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async () => { const msg = document.getElementById('smsg'); msg.textContent = ''; b.disabled = true;
  try { await api('/api/me/identities/' + b.dataset.unlink + '/unlink', {}); location.reload(); } catch (e) { msg.textContent = e.message; b.disabled = false; } });
bind('name', async (d, msg) => { await api('/api/me', d, 'PATCH'); say(msg, 'Saved.'); });
bind('user', async (d, msg) => { const r = await api('/api/me/username', d); say(msg, 'Your username is now ' + r.account.username + '.'); setTimeout(() => location.reload(), 900); });
bind('em', async (d, msg) => { await api('/api/email/change', d); say(msg, 'Check the new address for a confirmation link.'); });
bind('pw', async (d, msg) => { await api('/api/me/password', d); say(msg, 'Saved. Other devices were signed out.'); document.getElementById('pw').reset(); if (!HAS_PW) setTimeout(() => location.reload(), 900); });
bind('del', async d => { if (!confirm('Delete this account? This cannot be undone.')) return; await api('/api/me/delete', d); location.href = '/login'; });
"""
    return app("Settings", "Your profile and how you sign in.", account, "settings", inner,
               f"const HAS_PW = {_js(has_pw)};" + script)


def admin_page(account: dict) -> str:
    plans = "".join(f"<option value={p}>{p}</option>" for p in config.PLANS)
    inner = (
        "<div class=tabs><button class=on data-tab=accounts>Accounts</button><button data-tab=invites>Invites</button>"
        "<button data-tab=clients>Clients</button><button data-tab=audit>Audit log</button></div>"
        "<div id=tab-accounts><div class=toolbar><input id=q placeholder='Search username, e-mail or id' autocomplete=off><span class=spacer></span><span class=empty id=count></span></div>"
        "<div class=section><div class='body tbl'><table><thead><tr><th>Username</th><th>E-mail</th><th>Plan</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody id=accounts></tbody></table></div></div>"
        "<div class=actions><button class='btn btn--sm' id=more>Load more</button></div></div>"
        "<div id=tab-invites hidden><div class=section><h2>New invite</h2><div class=body><form id=inv class=inline>"
        "<label>Uses<input name=uses type=number value=1 min=1 max=10000></label>"
        f"<label>Plan<select name=plan>{plans}</select></label><label>Note<input name=note placeholder='who it is for'></label>"
        "<button type=submit class='btn btn--primary btn--sm'>Create</button><div class=msg></div></form></div></div>"
        "<div class=section><div class='body tbl'><table><thead><tr><th>Code</th><th>Uses left</th><th>Plan</th><th>Note</th><th>Created</th><th></th></tr></thead><tbody id=invites></tbody></table></div></div></div>"
        "<div id=tab-clients hidden><div class=section><h2>New client <span>a hosted Gamma server or the share host</span></h2><div class=body><form id=cli class=inline>"
        "<label>Name<input name=name required></label><label>Kind<select name=kind><option value=container>container</option><option value=share-host>share-host</option></select></label>"
        "<label>Callback URL<input name=redirect placeholder='https://name.gammapdf.com/api/auth/cloud/callback' required></label>"
        "<button type=submit class='btn btn--primary btn--sm'>Create</button><div class=msg></div></form><div id=secret hidden class=secretbox></div></div></div>"
        "<div class=section><div class='body tbl'><table><thead><tr><th>Client id</th><th>Name</th><th>Kind</th><th>Callback</th><th></th></tr></thead><tbody id=clients></tbody></table></div></div></div>"
        "<div id=tab-audit hidden><div class=section><div class='body tbl'><table><thead><tr><th>When</th><th>Event</th><th>Account</th><th>Actor</th><th>Detail</th></tr></thead><tbody id=audit></tbody></table></div></div></div>")
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
  document.querySelectorAll('[data-delinv]').forEach(b => b.onclick = () => act(b, async () => { await api('/api/admin/invites/' + b.dataset.delinv, undefined, 'DELETE'); load('invites'); }));
  document.querySelectorAll('[data-delcli]').forEach(b => b.onclick = () => { if (!confirm('Delete this client? Its servers can no longer sign people in.')) return; act(b, async () => { await api('/api/admin/clients/' + b.dataset.delcli, undefined, 'DELETE'); load('clients'); }); });
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

def authorize_page(req: dict, account, verify_needed: bool = False, social: dict | None = None) -> str:
    client = req["client"]
    who = esc(client["name"])
    rid = json.dumps(req["id"])
    if account and verify_needed:
        inner = (f"<p class=lead><b>{who}</b> wants to sign you in as <b>{esc(account['username'])}</b>, but your e-mail address is not "
                 "confirmed yet. Open the link we mailed you, then try again from the app.</p>"
                 "<button class='btn btn--block' data-resend>Resend the mail</button>"
                 "<p class=links><a href=/>Your account</a></p>")
        return auth("Confirm your e-mail first", "", inner, RESEND_JS)
    if account:
        inner = (f"<p class=lead>Continue as <b>{esc(account['username'])}</b> ({esc(account['email'])})?</p>"
                 "<button class='btn btn--primary btn--block' id=go>Continue</button>"
                 "<div class=actions><button class='btn btn--sm' id=other>Use another account</button>"
                 "<button class='btn btn--sm' id=cancel>Cancel</button></div><div class=msg id=err></div>")
        script = (f"document.getElementById('go').onclick = async () => {{ try {{ const d = await api('/authorize/continue', {{request_id: {rid}}}); "
                  f"location.href = d.redirect; }} catch (e) {{ document.getElementById('err').textContent = e.message; }} }};"
                  f"const err = document.getElementById('err');"
                  f"document.getElementById('other').onclick = (e) => act(e.target, async () => {{ await api('/api/logout', {{}}); location.reload(); }}, err);"
                  f"document.getElementById('cancel').onclick = (e) => act(e.target, async () => {{ const d = await api('/authorize/cancel', {{request_id: {rid}}}); "
                  f"if (d.redirect) location.href = d.redirect; }}, err);")
        return auth(f"Sign in to {client['name']}", "", inner, script)
    tiles, social_js = _social(social)
    inner = f"<form id=f>{_password_fields()}</form>{tiles}{_to_register()}{_terms()}"
    script = (f"bind('f', async d => {{ const r = await api('/authorize/login', {{request_id: {rid}, login: d.login, password: d.password}}); "
              f"if (r.verify_needed) location.reload(); else location.href = r.redirect; }});" + social_js)
    return auth(f"Sign in to {client['name']}", "Use your Gamma Cloud account.", inner, script)
