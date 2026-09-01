import { api, getSettings, login, normalizeServer, originPattern, setSettings } from "./api.js";

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);

let tab = null;
let state = null;
let picker = { folders: [], labels: [] };  // from GET /api/library/folders
let folderValue = "";                      // "" = library root, "__new__" = the new-folder input

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

// ---------- icons (mirrors frontend/src/icons.jsx — 24×24 stroke glyphs) ----------

const ICON_PATHS = {
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderPlus: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
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

  const kindLabel = { pdf: "PDF", arxiv: "arXiv", doi: "DOI", maybe: "possible paper", none: "" }[c.kind] || "";
  const idText = c.arxiv_id ? `arXiv:${c.arxiv_id}` : c.doi ? `doi:${c.doi}` : "";
  $("title").textContent = c.title || (c.kind === "none" ? (tab && tab.title) || "This page" : hostOf(c.pdf_url || c.source_url));
  $("sub").innerHTML = "";
  if (kindLabel) { const chip = document.createElement("span"); chip.className = "chip" + (c.kind === "maybe" ? " muted" : ""); chip.textContent = kindLabel; $("sub").appendChild(chip); }
  $("sub").appendChild(document.createTextNode(idText || (c.pdf_url && c.kind === "pdf" ? (c.is_pdf_tab ? "this tab is a PDF" : "PDF available") : hostOf(c.source_url || ""))));

  $("dot").className = "dot " + (st.hit ? "ok" : c.kind === "none" ? "" : "on");
  show("existing", !!st.hit);
  show("found", !st.hit && c.kind !== "none");
  show("nothing", !st.hit && c.kind === "none");
  show("clip-row", !c.is_pdf_tab);
  show("result", false);
  if (st.saving) { show("progress"); $("progress-text").textContent = st.saving; } else show("progress", false);
  if (st.error) { $("result").className = "msg err"; $("result").textContent = st.error; show("result"); }

  if (st.hit) $("title").textContent = st.hit.title || $("title").textContent;

  await fillPickers(st.settings);
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
  $("labels").value = (settings.labels || []).join(", ");
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

// Suggestions for the fragment after the last comma; picking one completes it.
function updateLabelMenu() {
  const menu = $("label-menu");
  const raw = $("labels").value;
  const cut = raw.lastIndexOf(",");
  const head = cut >= 0 ? raw.slice(0, cut + 1) : "";
  const frag = raw.slice(cut + 1).trim().toLowerCase();
  const chosen = new Set(head.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const items = picker.labels.filter((l) => !chosen.has(l.toLowerCase()) && l.toLowerCase().includes(frag)).slice(0, 8);
  menu.innerHTML = "";
  if (!items.length) { show("label-menu", false); return; }
  for (const l of items) {
    menu.appendChild(menuRow(l, "tag", false, () => {
      $("labels").value = (head ? head.replace(/\s*$/, " ") : "") + l + ", ";
      $("labels").focus();
      updateLabelMenu();
    }));
  }
  show("label-menu");
}

function chosenFolder() {
  return folderValue === "__new__" ? $("folder-new").value.trim() : folderValue;
}

function chosenLabels() {
  return $("labels").value.split(",").map((s) => s.trim()).filter(Boolean);
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
    await setSettings({ folder, labels });
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
  $("labels").addEventListener("input", updateLabelMenu);
  $("labels").addEventListener("focus", updateLabelMenu);
  $("labels").addEventListener("blur", () => show("label-menu", false));
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#folder-wrap")) show("folder-menu", false);
    if (!e.target.closest("#labels-wrap")) show("label-menu", false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { show("folder-menu", false); show("label-menu", false); }
  });
  $("save").onclick = () => doSave();
  $("save-anyway").onclick = () => doSave({ candidate: { kind: "none", source_url: tab.url, title: tab.title }, force: true });
  $("open-existing").onclick = () => openPath(state.hit.open_url);
  $("refile").onclick = () => { show("existing", false); show("found"); };
  $("clip").onclick = doClip;
  // Progress written by the worker while a save runs (even if this popup was reopened).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session" || !tab) return;
    const ch = changes[`tab:${tab.id}`];
    if (!ch || !ch.newValue) return;
    const st = ch.newValue;
    if (st.saving) { show("progress"); $("progress-text").textContent = st.saving; }
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
