import { api, getSettings, login, normalizeServer, originPattern, setSettings } from "./api.js";

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);

let tab = null;
let state = null;

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

// ---------- views ----------

function showSetup() {
  show("view-setup"); show("view-login", false); show("view-main", false);
  $("setup-server").focus();
}

function showLogin(st) {
  show("view-setup", false); show("view-login"); show("view-main", false);
  $("login-server").textContent = st.error ? `Can't reach ${st.origin}: ${st.error}` : st.origin;
  $("login-foot").textContent = hostOf(st.origin);
  $("login-user").focus();
}

async function showMain(st) {
  show("view-setup", false); show("view-login", false); show("view-main");
  const c = st.candidate || { kind: "none" };
  $("foot").textContent = `${hostOf(st.origin)} · ${st.user}`;

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

  // Upload-from-tab: the tab is a PDF, or the PDF link lives on this site.
  let sameSitePdf = false;
  try { sameSitePdf = !!c.pdf_url && new URL(c.pdf_url).origin === new URL(c.source_url).origin; } catch {}
  show("upload-row", !st.hit && (c.is_pdf_tab || sameSitePdf));
  $("upload").checked = !!c.is_pdf_tab;

  await fillPickers(st.settings);
}

async function fillPickers(settings) {
  const sel = $("folder");
  sel.innerHTML = "";
  const add = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; sel.appendChild(o); return o; };
  add("", "Library root");
  let folders = [], labels = [];
  try { ({ folders = [], labels = [] } = await api("/library/folders")); } catch {}
  const remembered = settings.folder || "";
  if (remembered && !folders.includes(remembered)) folders.unshift(remembered);
  for (const f of folders) add(f, f);
  add("__new__", "New folder…");
  sel.value = folders.includes(remembered) ? remembered : "";
  show("folder-new-row", false);
  $("labels").value = (settings.labels || []).join(", ");
  $("label-list").innerHTML = "";
  for (const l of labels) { const o = document.createElement("option"); o.value = l; $("label-list").appendChild(o); }
}

function chosenFolder() {
  const v = $("folder").value;
  return v === "__new__" ? $("folder-new").value.trim() : v;
}

function chosenLabels() {
  return $("labels").value.split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------- actions ----------

async function doSave({ candidate, force } = {}) {
  const c = candidate || state.candidate;
  const folder = chosenFolder();
  const labels = chosenLabels();
  const uploadFromTab = !$("upload-row").classList.contains("hidden") && $("upload").checked;
  $("save").disabled = true; $("save-anyway").disabled = true;
  show("result", false);
  show("progress"); $("progress-text").textContent = "starting…";
  try {
    if (uploadFromTab) {
      const url = c.pdf_url || c.source_url;
      const granted = await chrome.permissions.request({ origins: [originPattern(new URL(url).origin)] });
      if (!granted) throw new Error("permission to read this site was declined");
    }
    await setSettings({ folder, labels });
    const out = await send({ type: "save", tabId: tab.id, candidate: c, folder, labels, uploadFromTab, source_url: force ? (tab && tab.url) : undefined });
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
  else if (!state.auth) showLogin(state);
  else await showMain(state);
}

// ---------- wiring ----------

document.addEventListener("DOMContentLoaded", async () => {
  // ?tab=<id> targets a specific tab (used when the popup is opened as a page, e.g. in tests).
  const wanted = new URLSearchParams(location.search).get("tab");
  if (wanted) { try { tab = await chrome.tabs.get(Number(wanted)); } catch {} }
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("setup-connect").onclick = doConnect;
  $("setup-server").addEventListener("keydown", (e) => { if (e.key === "Enter") doConnect(); });
  $("login-form").addEventListener("submit", doLogin);
  $("login-btn").onclick = doLogin;
  $("gear").onclick = $("gear-login").onclick = () => chrome.runtime.openOptionsPage();
  $("folder").onchange = () => { show("folder-new-row", $("folder").value === "__new__"); if ($("folder").value === "__new__") $("folder-new").focus(); };
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
    await refresh();
  } catch (err) {
    showSetup();
    $("setup-msg").textContent = err.message; show("setup-msg");
  }
});
