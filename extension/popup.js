import { api, getSettings, login, normalizeServer, originPattern, setSettings } from "./api.js";
import { connectPublisher, describeSession, publisherHost, publisherRoot } from "./publisherSessions.js";

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);

let tab = null;
let state = null;
let picker = { folders: [], labels: [] };  // from GET /api/library/folders
let folderValue = "";                      // "" = library root, "__new__" = the new-folder input
let labelTags = [];                        // committed label chips; #labels holds the fragment being typed
let labelSelIdx = -1;                      // keyboard selection in the label suggestion menu
let pub = null;                            // publisher sessions: the worker's `publisher-status` answer
let cookieTimer = 0;                       // the cookie button's "done" flash

async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (!r) throw new Error("no response from the extension");
  if (!r.ok) { const e = new Error(r.error); e.status = r.status; throw e; }
  return r.result;
}

function hostOf(origin) {
  try { return new URL(origin).host; } catch { return origin; }
}

function openPath(path) {
  send({ type: "open", path }).then(() => window.close());
}

// ---------- icons (mirrors frontend/src/shared/ui/Icons.jsx — 24×24 stroke glyphs) ----------

const ICON_PATHS = {
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderPlus: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',

  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  cookie: '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/>',
};

function icon(name, cls = "", size = 13, strokeWidth = 2) {
  const span = document.createElement("span");
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ""}>${ICON_PATHS[name]}</svg>`;
  return span.firstChild;
}

// ---------- views ----------

const VIEWS = ["view-setup", "view-offline", "view-login", "view-main"];
function view(id) { for (const v of VIEWS) show(v, v === id); }

function setConn(cls, title) {
  const el = $("conn");
  el.className = "connDot " + cls;
  el.title = title;
}

function showSetup() {
  view("view-setup");
  $("setup-server").focus();
}

function showOffline(st) {
  view("view-offline");
  $("offline-server").textContent = st.origin;
  // st.error already reads "Can't reach <origin> (…)" (api.js).
  $("offline-msg").textContent = `${st.error || `Can't reach ${st.origin}`}. Is the server running, and the address right?`;
  $("offline-foot").textContent = hostOf(st.origin);
}

function showLogin(st) {
  view("view-login");
  $("login-server").textContent = st.origin;
  $("login-foot").textContent = hostOf(st.origin);
  $("login-user").focus();
}

async function showMain(st) {
  view("view-main");
  const c = st.candidate || { kind: "none" };
  $("foot").textContent = `${hostOf(st.origin)} · ${st.user}`;
  setConn("ok", `Connected to ${st.origin} — signed in as ${st.user}`);

  renderHead(st);

  $("dot").className = "dot " + (st.hit ? "ok" : c.kind === "none" ? "" : "on");
  show("existing", !!st.hit);
  show("found", !st.hit && c.kind !== "none");
  show("nothing", !st.hit && c.kind === "none");
  show("clip-row", !c.is_pdf_tab);
  show("result", false);
  if (st.saving) { show("progress"); $("progress-text").textContent = st.saving; } else show("progress", false);
  if (st.error) { $("result").className = "msg err"; $("result").textContent = st.error; show("result"); }

  await fillPickers(st.settings);
  $("pub-auto").checked = st.settings.autoRefreshSessions !== false;
  await loadPublisher(st);
}

// ---------- publisher sessions: the footer's cookie button + drawer ----------
//
// The button's state names what a click would do on THIS tab: `off` (not a
// journal page — the drawer still lists connected hosts), `ready` (a journal
// host, not connected yet), `connected`, `saving` (the cookie wobbles inside a
// spinning ring while the snapshot uploads), `done` (a green check pops for a
// moment), `err`. Hidden for guests, incognito tabs and older servers.

function cookieState(cls, title) {
  const b = $("cookie-btn");
  b.className = "footBtn cookieBtn " + cls;
  if (title) b.title = title;
}

// What this tab's host means for the drawer: {host, root, session}.
function currentPublisher() {
  if (!pub || !pub.supported) return { host: "", root: "", session: null };
  const host = publisherHost(tab && tab.url, pub.roots);
  return { host, root: publisherRoot(host, pub.roots), session: pub.sessions.find((s) => s.host === host) || null };
}

async function loadPublisher(st, force = false) {
  try { pub = await send({ type: "publisher-status", force }); }
  catch (err) { pub = { supported: false, error: err.message }; }
  renderCookie(st);
}

function renderCookie(st) {
  const usable = pub && pub.supported && !(tab && tab.incognito);
  show("cookie-btn", !!usable);
  if (!usable) { closeDrawer(); return; }
  const { host, session } = currentPublisher();
  const n = pub.sessions.length;
  const count = n ? ` · ${n} connected` : "";
  if (session) cookieState("connected", `${host}: session connected (${describeSession(session)})${count}`);
  else if (host) cookieState("ready", `Connect ${host}'s session to Gamma${count}`);
  else cookieState("off", `Publisher sessions${count}`);
  if (!$("cookie-drawer").classList.contains("hidden")) renderDrawer(st);
}

function renderDrawer(st) {
  const { host, root, session } = currentPublisher();
  const secure = !!pub.secure;
  const stateChip = $("pub-state");
  if (host) {
    $("pub-host").textContent = host;
    stateChip.className = "chip " + (session ? "ok" : "muted");
    stateChip.textContent = session ? "connected" : "not connected";
    $("pub-meta").textContent = session ? describeSession(session)
      : secure ? `Signed in here? Send its cookies to ${hostOf(st.origin)} · ${st.user} so the server can download this journal's PDFs.`
      : "Connecting needs an HTTPS or localhost Gamma server.";
    show("pub-connect", secure);
    $("pub-connect").textContent = session ? "Refresh now" : "Connect this journal";
    $("pub-connect").onclick = () => doConnectPublisher(st, host, root, session);
  } else {
    $("pub-host").textContent = "No journal on this tab";
    stateChip.className = "chip muted hidden";
    $("pub-meta").textContent = `Open an article or PDF on a supported publisher over HTTPS to connect its session. Supported: ${pub.roots.join(", ")}.`;
    show("pub-connect", false);
  }
  stateChip.classList.toggle("hidden", !host);
  // The last automatic refresh for this host, when it failed — a silent
  // success just shows up as a newer "refreshed … ago".
  if (pub.auto && pub.auto.host === host && !pub.auto.ok && session) {
    $("pub-meta").textContent += ` · automatic refresh failed: ${pub.auto.error}`;
  }
  const list = $("pub-list");
  list.replaceChildren();
  for (const s of pub.sessions) {
    if (s.host === host) continue;
    const row = document.createElement("div"); row.className = "pubRow";
    const ic = document.createElement("span"); ic.className = "ctxMenuIcon"; ic.appendChild(icon("cookie"));
    const text = document.createElement("span"); text.className = "pubRowText";
    const h = document.createElement("span"); h.className = "pubRowHost"; h.textContent = s.host;
    const m = document.createElement("span"); m.className = "pubRowMeta"; m.textContent = describeSession(s);
    text.append(h, m);
    const x = document.createElement("button"); x.type = "button"; x.className = "uiClose"; x.textContent = "×"; x.title = `Disconnect ${s.host}`;
    x.onclick = () => doDisconnectPublisher(st, s.host, x);
    row.append(ic, text, x);
    list.append(row);
  }
  show("pub-list", list.children.length > 0);
}

function openDrawer(st) {
  renderDrawer(st);
  show("cookie-drawer");
  $("cookie-btn").setAttribute("aria-expanded", "true");
  $("cookie-drawer").scrollIntoView({ block: "nearest" });
}

function closeDrawer() {
  show("cookie-drawer", false);
  show("pub-msg", false);
  $("cookie-btn").setAttribute("aria-expanded", "false");
}

function pubMessage(text, error = false) {
  $("pub-msg").className = "msg " + (error ? "err" : "ok");
  $("pub-msg").textContent = text;
}

async function doConnectPublisher(st, host, root, session) {
  const btn = $("pub-connect");
  btn.disabled = true;
  btn.classList.add("busy");
  btn.innerHTML = '<span class="spinner light"></span>' + (session ? "Refreshing…" : "Connecting…");
  cookieState("saving", `Sending ${host}'s cookies to Gamma…`);
  show("pub-msg", false);
  clearTimeout(cookieTimer);
  try {
    // Must be invoked directly from the user's gesture, before other awaits.
    const granted = await chrome.permissions.request({ permissions: ["cookies"] });
    if (!granted) throw new Error("Cookie access was declined. PDF saving still works.");
    await connectPublisher({ tabId: tab.id, host, root, user: st.user, origin: st.origin });
    pub = await send({ type: "publisher-status", force: true });
    cookieState("done", `${host}: session connected`);
    btn.classList.replace("busy", "done");
    btn.innerHTML = ""; btn.append(icon("check", "", 13, 2.4), document.createTextNode(session ? " Refreshed" : " Connected"));
    pubMessage(session ? "Session refreshed. Gamma has this journal's current cookies." : "Session connected. Gamma can use it for this journal's PDF downloads.");
    cookieTimer = setTimeout(() => { btn.disabled = false; btn.classList.remove("done"); renderCookie(st); renderDrawer(st); }, 1600);
  } catch (err) {
    pubMessage(err.message, true);
    cookieState("err", err.message);
    btn.disabled = false;
    btn.classList.remove("busy");
    cookieTimer = setTimeout(() => renderCookie(st), 1600);
    renderDrawer(st);
    if (err.status === 401) { state = await send({ type: "auth-changed" }); showLogin(state); }
  }
}

async function doDisconnectPublisher(st, host, button) {
  button.disabled = true;
  try {
    await api(`/publisher-sessions/${encodeURIComponent(host)}`, { method: "DELETE", expectedUser: st.user, expectedOrigin: st.origin });
    pub = await send({ type: "publisher-status", force: true });
    renderCookie(st); renderDrawer(st);
    pubMessage(`${host} disconnected — Gamma's copy of its cookies is deleted.`);
  } catch (err) { pubMessage(err.message, true); button.disabled = false; }
}

// The head names the paper on THIS tab: the page's own title (meta tags),
// else the registry record the worker previewed for the detected DOI /
// arXiv id (a PDF tab has no meta tags), else the library page's title,
// else the host. The identifier line shows what the detection rests on, the
// third line the registry's authors · year · venue.
function renderHead(st) {
  const c = st.candidate || { kind: "none" };
  const pv = st.preview || null;
  const kindLabel = { pdf: "PDF", arxiv: "arXiv", doi: "DOI", maybe: "possible paper", none: "" }[c.kind] || "";
  const idText = c.arxiv_id ? `arXiv:${c.arxiv_id}` : c.doi ? `doi:${c.doi}` : "";
  const title = c.title || (pv && pv.title) || (st.hit && st.hit.title)
    || (c.kind === "none" ? (tab && tab.title) || "This page" : hostOf(c.pdf_url || c.source_url));
  $("title").textContent = title;
  const sub = $("sub");
  sub.innerHTML = "";
  if (kindLabel) { const chip = document.createElement("span"); chip.className = "chip" + (c.kind === "maybe" ? " muted" : ""); chip.textContent = kindLabel; sub.appendChild(chip); }
  sub.appendChild(document.createTextNode(idText || (c.pdf_url && c.kind === "pdf" ? (c.is_pdf_tab ? "this tab is a PDF" : "PDF available") : hostOf(c.source_url || ""))));
  if (pv) {
    const authors = pv.authors || [];
    const who = authors.length > 3 ? `${authors[0]} et al.` : authors.join(", ");
    const line = [who, pv.year, pv.venue].filter(Boolean).join(" · ");
    if (line) { const el = document.createElement("div"); el.className = "meta"; el.textContent = line; el.title = authors.join(", "); sub.appendChild(el); }
  }
  // The library page may carry a different title (a stale or wrong metadata
  // record) — say so instead of silently showing it as this paper's.
  const norm = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const libTitle = st.hit && st.hit.title || "";
  $("existing-as").textContent = libTitle && norm(libTitle) !== norm(title) ? ` as “${libTitle}”` : "";
}

// ---------- folder + label pickers (MenuSelect / ctxMenu style, plain JS) ----------

async function fillPickers(settings) {
  try { const r = await api("/library/folders"); picker = { folders: r.folders || [], labels: r.labels || [] }; }
  catch { picker = { folders: [], labels: [] }; }
  const remembered = settings.folder || "";
  if (remembered && !picker.folders.includes(remembered)) picker.folders.unshift(remembered);
  folderValue = picker.folders.includes(remembered) ? remembered : "";
  renderFolderBtn();
  show("folder-new-row", false);
  // Prefill the options-page default labels only — the last save's labels are
  // deliberately not remembered (doSave persists just the folder).
  labelTags = [...new Set((settings.labels || []).map((s) => String(s).trim()).filter(Boolean))];
  renderLabelTags();
  $("labels").value = "";
}

function renderFolderBtn() {
  const btn = $("folder-btn");
  btn.innerHTML = "";
  const ic = document.createElement("span"); ic.className = "ctxMenuIcon";
  ic.appendChild(icon(folderValue === "__new__" ? "folderPlus" : "folder"));
  const label = document.createElement("span"); label.className = "uiSelectLabel";
  label.textContent = folderValue === "__new__" ? "New folder…" : (folderValue || "Library root");
  btn.title = label.textContent;
  btn.append(ic, label, icon("chevronDown", "uiSelectChev"));
}

function menuRow(text, iconName, selected, onPick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ctxMenuItem ctxMenuItemIconed";
  const ic = document.createElement("span"); ic.className = "ctxMenuIcon"; ic.appendChild(icon(iconName));
  const t = document.createElement("span"); t.className = "ctxMenuText"; t.textContent = text; t.title = text;
  b.append(ic, t);
  if (selected) b.appendChild(icon("check", "ctxMenuCheck", 13, 2.4));
  // mousedown, not click: keeps focus where it is (the labels input relies on this).
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onPick);
  return b;
}

function openFolderMenu() {
  const menu = $("folder-menu");
  menu.innerHTML = "";
  const pick = (value) => () => {
    folderValue = value;
    renderFolderBtn();
    show("folder-menu", false);
    show("folder-new-row", value === "__new__");
    if (value === "__new__") $("folder-new").focus();
  };
  menu.appendChild(menuRow("Library root", "folder", folderValue === "", pick("")));
  for (const f of picker.folders) menu.appendChild(menuRow(f, "folder", folderValue === f, pick(f)));
  menu.appendChild(menuRow("New folder…", "folderPlus", folderValue === "__new__", pick("__new__")));
  show("folder-menu");
}

// Labels are the app's categoryTag chips: typing "," or Enter commits the
// fragment as a chip, Backspace on an empty input removes the last one, and
// the suggestion menu (existing library labels) completes the fragment.
function addLabelTag(name) {
  const t = (name || "").trim();
  if (t && !labelTags.some((l) => l.toLowerCase() === t.toLowerCase())) labelTags.push(t);
  renderLabelTags();
}

function renderLabelTags() {
  const box = $("labels-box");
  const input = $("labels");
  for (const chip of box.querySelectorAll(".categoryTag")) chip.remove();
  for (const t of labelTags) {
    const chip = document.createElement("span");
    chip.className = "categoryTag";
    chip.appendChild(document.createTextNode(t));
    const x = document.createElement("button");
    x.type = "button"; x.className = "uiClose"; x.tabIndex = -1; x.textContent = "×"; x.title = `Remove "${t}"`;
    x.addEventListener("mousedown", (e) => e.preventDefault());
    x.addEventListener("click", () => { labelTags = labelTags.filter((l) => l !== t); renderLabelTags(); updateLabelMenu(); });
    chip.appendChild(x);
    box.insertBefore(chip, input);
  }
}

function labelSuggestions() {
  const frag = $("labels").value.trim().toLowerCase();
  const chosen = new Set(labelTags.map((l) => l.toLowerCase()));
  return picker.labels.filter((l) => !chosen.has(l.toLowerCase()) && l.toLowerCase().includes(frag)).slice(0, 8);
}

function updateLabelMenu() {
  const menu = $("label-menu");
  const items = labelSuggestions();
  if (labelSelIdx >= items.length) labelSelIdx = items.length - 1;
  menu.innerHTML = "";
  if (!items.length) { show("label-menu", false); return; }
  items.forEach((l, i) => {
    const row = menuRow(l, "tag", false, () => {
      addLabelTag(l);
      $("labels").value = ""; labelSelIdx = -1;
      $("labels").focus();
      updateLabelMenu();
    });
    if (i === labelSelIdx) row.classList.add("selected");
    row.addEventListener("mouseenter", () => {
      labelSelIdx = i;
      [...menu.children].forEach((el, j) => el.classList.toggle("selected", j === i));
    });
    menu.appendChild(row);
  });
  show("label-menu");
}

function chosenFolder() {
  return folderValue === "__new__" ? $("folder-new").value.trim() : folderValue;
}

function chosenLabels() {
  const frag = $("labels").value.trim();  // count an uncommitted fragment too
  return frag && !labelTags.some((l) => l.toLowerCase() === frag.toLowerCase())
    ? [...labelTags, frag] : [...labelTags];
}

// ---------- actions ----------

async function doSave({ candidate, force } = {}) {
  const c = candidate || state.candidate;
  const folder = chosenFolder();
  const labels = chosenLabels();
  $("save").disabled = true; $("save-anyway").disabled = true;
  show("result", false);
  show("progress"); $("progress-text").textContent = "starting…";
  try {
    // The worker may need to download the PDF in the browser (PDF tab, or
    // fallback when the server can't get past a paywall) — secure the host
    // permission while we still have the user's click. Best-effort: normally
    // <all_urls> is already granted and this resolves silently.
    const fetchUrl = c.pdf_url || (c.is_pdf_tab ? c.source_url : "");
    if (fetchUrl) { try { await chrome.permissions.request({ origins: [originPattern(new URL(fetchUrl).origin)] }); } catch {} }
    // Remember the folder for next time; labels are per-paper, so they are
    // NOT persisted — the next popup starts from the options-page defaults.
    await setSettings({ folder });
    const out = await send({ type: "save", tabId: tab.id, candidate: c, folder, labels, source_url: force ? (tab && tab.url) : undefined });
    show("progress", false);
    const r = $("result");
    r.className = "msg " + (out.note ? "warn" : "ok");
    r.innerHTML = "";
    r.appendChild(document.createTextNode((out.existed ? "Already in your library: " : "Saved: ") + (out.title || "") + (out.note ? ` — ${out.note} ` : " ")));
    const a = document.createElement("a"); a.href = "#"; a.textContent = "Open in Gamma";
    a.onclick = (e) => { e.preventDefault(); openPath(out.open_url); };
    r.appendChild(a);
    show("result");
    show("found", false); show("nothing", false);
    $("dot").className = "dot ok";
  } catch (err) {
    show("progress", false);
    $("result").className = "msg err";
    $("result").textContent = err.message;
    show("result");
    if (err.status === 401) { state = await send({ type: "auth-changed" }); showLogin(state); }
  } finally {
    $("save").disabled = false; $("save-anyway").disabled = false;
  }
}

async function doClip() {
  $("clip").disabled = true;
  show("result", false);
  try {
    const out = await send({ type: "clip-selection", tabId: tab.id, source_url: tab.url, title: tab.title });
    const r = $("result"); r.className = "msg ok"; r.innerHTML = "";
    r.appendChild(document.createTextNode("Clipped. "));
    const a = document.createElement("a"); a.href = "#"; a.textContent = "Open in Gamma";
    a.onclick = (e) => { e.preventDefault(); openPath(out.open_url); };
    r.appendChild(a); show("result");
  } catch (err) {
    $("result").className = "msg err"; $("result").textContent = err.message === "nothing selected" ? "Select some text on the page first." : err.message; show("result");
  } finally { $("clip").disabled = false; }
}

async function doConnect() {
  const origin = normalizeServer($("setup-server").value);
  const msg = $("setup-msg");
  if (!origin) { msg.textContent = "Enter a valid URL."; show("setup-msg"); return; }
  const granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
  if (!granted) { msg.textContent = "Permission to talk to that server was declined."; show("setup-msg"); return; }
  await setSettings({ server: origin });
  show("setup-msg", false);
  await refresh(true);
}

async function doLogin(e) {
  if (e) e.preventDefault();
  $("login-btn").disabled = true;
  try {
    await login($("login-user").value.trim(), $("login-pass").value);
    show("login-msg", false);
    await refresh(true);
  } catch (err) {
    $("login-msg").textContent = err.status === 401 ? "Wrong username or password." : err.message;
    show("login-msg");
  } finally { $("login-btn").disabled = false; }
}

async function refresh(forceAuth = false) {
  state = await send({ type: "get-state", tabId: tab && tab.id, forceAuth });
  if (!state.configured) showSetup();
  else if (state.auth === null) showOffline(state);   // configured but unreachable
  else if (!state.auth) showLogin(state);
  else await showMain(state);
}

// ---------- wiring ----------

document.addEventListener("DOMContentLoaded", async () => {
  // ?tab=<id> targets a specific tab (used when the popup is opened as a page, e.g. in tests).
  const wanted = new URLSearchParams(location.search).get("tab");
  if (wanted) { try { tab = await chrome.tabs.get(Number(wanted)); } catch {} }
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  for (const g of document.querySelectorAll(".gearBtn")) {
    g.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-gear"/></svg>';
    g.onclick = () => chrome.runtime.openOptionsPage();
  }
  $("setup-connect").onclick = doConnect;
  $("setup-server").addEventListener("keydown", (e) => { if (e.key === "Enter") doConnect(); });
  $("login-form").addEventListener("submit", doLogin);
  $("login-btn").onclick = doLogin;
  $("offline-retry").onclick = () => refresh(true);
  $("folder-btn").onclick = () => { $("folder-menu").classList.contains("hidden") ? openFolderMenu() : show("folder-menu", false); };
  $("labels-box").addEventListener("pointerdown", (e) => {
    if (e.target === $("labels-box")) { e.preventDefault(); $("labels").focus(); }
  });
  $("labels").addEventListener("input", () => {
    const val = $("labels").value;
    if (val.includes(",")) {
      const parts = val.split(",");
      for (const p of parts.slice(0, -1)) addLabelTag(p);
      $("labels").value = parts[parts.length - 1].trimStart();
    }
    labelSelIdx = -1;
    updateLabelMenu();
  });
  $("labels").addEventListener("keydown", (e) => {
    const items = labelSuggestions();
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault(); labelSelIdx = Math.min(labelSelIdx + 1, items.length - 1); updateLabelMenu();
    } else if (e.key === "ArrowUp" && !$("label-menu").classList.contains("hidden")) {
      e.preventDefault(); labelSelIdx = Math.max(labelSelIdx - 1, -1); updateLabelMenu();
    } else if (e.key === "Enter") {
      e.preventDefault();
      addLabelTag(labelSelIdx >= 0 && labelSelIdx < items.length ? items[labelSelIdx] : $("labels").value);
      $("labels").value = ""; labelSelIdx = -1;
      updateLabelMenu();
    } else if (e.key === "Backspace" && !$("labels").value && labelTags.length) {
      labelTags.pop(); renderLabelTags(); updateLabelMenu();
    }
  });
  $("labels").addEventListener("focus", updateLabelMenu);
  $("labels").addEventListener("blur", () => { labelSelIdx = -1; show("label-menu", false); });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#folder-wrap")) show("folder-menu", false);
    if (!e.target.closest("#labels-wrap")) show("label-menu", false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { show("folder-menu", false); show("label-menu", false); closeDrawer(); }
  });
  $("save").onclick = () => doSave();
  $("save-anyway").onclick = () => doSave({ candidate: { kind: "none", source_url: tab.url, title: tab.title }, force: true });
  $("open-existing").onclick = () => openPath(state.hit.open_url);
  $("refile").onclick = () => { show("existing", false); show("found"); };
  $("clip").onclick = doClip;
  $("clip").append(icon("scissors", "", 12, 2), document.createTextNode("Clip selected text"));
  $("cookie-glyph").appendChild(icon("cookie", "", 16, 2));
  $("drawer-icon").appendChild(icon("cookie", "", 15, 2));
  $("cookie-btn").onclick = () => { $("cookie-drawer").classList.contains("hidden") ? openDrawer(state) : closeDrawer(); };
  $("cookie-close").onclick = closeDrawer;
  $("pub-auto").addEventListener("change", () => setSettings({ autoRefreshSessions: $("pub-auto").checked }));
  // Progress written by the worker while a save runs (even if this popup was reopened).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session" || !tab) return;
    // The worker refreshed a journal session in the background while the popup is open.
    if (changes["publisher:auto"] && state && pub && pub.supported) loadPublisher(state, true);
    const ch = changes[`tab:${tab.id}`];
    if (!ch || !ch.newValue) return;
    const st = ch.newValue;
    if (st.saving) { show("progress"); $("progress-text").textContent = st.saving; }
    // The registry preview lands after the popup opened — show it.
    if (st.preview && state && !state.preview && state.candidate && st.candidate
        && st.candidate.source_url === state.candidate.source_url) {
      state = { ...state, preview: st.preview };
      renderHead(state);
    }
  });
  try {
    const settings = await getSettings();
    if (settings.server) $("setup-server").value = settings.server;
    // Force a fresh session check so the footer's connection dot is truthful.
    await refresh(true);
  } catch (err) {
    showSetup();
    $("setup-msg").textContent = err.message; show("setup-msg");
  }
});
