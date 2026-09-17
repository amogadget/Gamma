import { api, getSettings, login, normalizeServer, originPattern, setSettings } from "./api.js";
import { connectPublisher, publisherHost, secureServer } from "./publisherSessions.js";

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);

let tab = null;
let state = null;
let picker = { folders: [], labels: [] };  // from GET /api/library/folders
let folderValue = "";                      // "" = library root, "__new__" = the new-folder input
let labelTags = [];                        // committed label chips; #labels holds the fragment being typed
let labelSelIdx = -1;                      // keyboard selection in the label suggestion menu

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
  await renderPublisherSessions(st);
}

async function renderPublisherSessions(st) {
  show("publisher-sessions", false);
  if (st.user === "guest" || tab?.incognito) return;
  try {
    const data = await api("/publisher-sessions", { expectedUser: st.user, expectedOrigin: st.origin });
    show("publisher-sessions");
    const host = publisherHost(tab?.url, data.publisher_roots);
    const root = data.publisher_roots.find((r) => host === r || host.endsWith("." + r));
    const connected = data.sessions.some((s) => s.host === host);
    const allowed = secureServer(st.origin);
    $("publisher-target").textContent = host
      ? `${host} → ${hostOf(st.origin)} · ${st.user}${allowed ? "" : " — HTTPS or localhost required"}`
      : "Open a supported publisher page to connect its session.";
    show("publisher-connect", !!host && allowed);
    $("publisher-connect").textContent = connected ? "Refresh publisher session" : "Connect publisher session";
    $("publisher-connect").onclick = async () => {
      $("publisher-connect").disabled = true;
      try {
        // Must be invoked directly from the user's gesture, before other awaits.
        const granted = await chrome.permissions.request({ permissions: ["cookies"] });
        if (!granted) throw new Error("Cookie access was declined. PDF saving still works.");
        await connectPublisher({ tabId: tab.id, host, root, user: st.user, origin: st.origin });
        await renderPublisherSessions(st);
        publisherMessage("Session connected. Gamma can use it for future PDF downloads.");
      } catch (err) { publisherMessage(err.message, true); }
      finally { $("publisher-connect").disabled = false; }
    };
    const list = $("publisher-list");
    list.replaceChildren();
    for (const session of data.sessions) {
      const row = document.createElement("div"); row.className = "row";
      const label = document.createElement("span"); label.textContent = session.host;
      label.title = `Expires no later than ${new Date(session.expires_at * 1000).toLocaleString()}`;
      const button = document.createElement("button"); button.className = "linkBtn"; button.textContent = "Disconnect";
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api(`/publisher-sessions/${encodeURIComponent(session.host)}`, {
            method: "DELETE", expectedUser: st.user, expectedOrigin: st.origin,
          });
          await renderPublisherSessions(st);
          publisherMessage("Session removed from Gamma.");
        } catch (err) { publisherMessage(err.message, true); button.disabled = false; }
      };
      row.append(label, button); list.append(row);
    }
  } catch (err) {
    // Older servers simply do not offer session connections.
    if (err.status !== 404) { show("publisher-sessions"); publisherMessage(err.message, true); }
  }
}

function publisherMessage(text, error = false) {
  $("publisher-msg").className = "msg " + (error ? "err" : "ok");
  $("publisher-msg").textContent = text;
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
