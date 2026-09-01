// Service worker: per-tab detection state + toolbar badge, the save pipeline
// (thin — one POST /api/clip does the ingest server-side), context menus, the
// keyboard command, and the popup's message API. State lives in
// chrome.storage.session so it survives the worker being put to sleep.

import { api, ApiError, getSettings, serverOrigin, whoAmI } from "./api.js";

const ICON_ON = { 16: "icons/icon16.png", 32: "icons/icon32.png" };
const ICON_OFF = { 16: "icons/icon16-off.png", 32: "icons/icon32-off.png" };
const COLORS = { accent: "#3a7bd5", ok: "#2e8b5e", danger: "#c94a4a", muted: "#7a828e" };

const DOI_RE = /10\.\d{4,9}\/[^\s"'<>?#]+/;
const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i;

// ---------- per-tab state ----------

const key = (tabId) => `tab:${tabId}`;

async function getTabState(tabId) {
  const r = await chrome.storage.session.get(key(tabId));
  return r[key(tabId)] || {};
}

async function setTabState(tabId, patch) {
  const next = { ...(await getTabState(tabId)), ...patch };
  await chrome.storage.session.set({ [key(tabId)]: next });
  updateBadge(tabId, next).catch(() => {});
  return next;
}

async function updateBadge(tabId, st) {
  const kind = st.candidate && st.candidate.kind || "none";
  let text = "", color = COLORS.accent, on = false;
  if (st.auth === false) { text = "!"; color = COLORS.danger; }
  else if (st.hit) { text = "✓"; color = COLORS.ok; on = true; }
  else if (kind === "pdf") { text = "PDF"; on = true; }
  else if (kind === "arxiv") { text = "arX"; on = true; }
  else if (kind === "doi") { text = "DOI"; on = true; }
  else if (kind === "maybe") { text = "?"; color = COLORS.muted; on = true; }
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setIcon({ tabId, path: on ? ICON_ON : ICON_OFF });
  } catch {}
}

// Tabs without a content script (Chrome's PDF viewer, restricted pages):
// what the URL alone tells us.
function candidateFromUrl(url, title) {
  if (!url || !/^https?:/i.test(url)) return { kind: "none", source_url: url || "" };
  const isPdf = /\.pdf($|[?#])/i.test(url.split("?")[0]);
  const ax = url.match(ARXIV_RE);
  let doi = "";
  if (/https?:\/\/(?:dx\.)?doi\.org\//i.test(url) || /\/doi\/(?:abs|full|pdf)?\/?10\./i.test(url)) {
    const m = url.match(DOI_RE);
    if (m) { try { doi = decodeURIComponent(m[0]).replace(/[.,;)\]]+$/, ""); } catch { doi = m[0]; } }
  }
  const arxivId = ax ? ax[1] : "";
  const isArxivPdf = /arxiv\.org\/pdf\//i.test(url);
  const pdfUrl = isPdf || isArxivPdf ? url : "";
  const kind = pdfUrl ? "pdf" : arxivId ? "arxiv" : doi ? "doi" : "none";
  let cleanTitle = (title || "").replace(/\s+/g, " ").trim();
  // Chrome titles PDF tabs with their URL or filename — no better than the
  // server's own fallback, and the metadata lookup replaces it anyway.
  if (cleanTitle && (url.includes(cleanTitle) || /\.pdf$/i.test(cleanTitle))) cleanTitle = "";
  return { kind, source_url: url, pdf_url: pdfUrl, arxiv_id: arxivId, doi,
           title: cleanTitle, is_pdf_tab: isPdf || isArxivPdf, from_url: true };
}

// Content-script detection wins over the URL guess, field by field.
function mergeCandidates(fromPage, fromUrl) {
  if (!fromPage) return fromUrl;
  if (!fromUrl) return fromPage;
  const c = { ...fromUrl, ...fromPage, from_url: false };
  for (const k of ["pdf_url", "arxiv_id", "doi", "title"]) if (!c[k] && fromUrl[k]) c[k] = fromUrl[k];
  if (c.kind === "none" && fromUrl.kind !== "none") c.kind = fromUrl.kind;
  c.is_pdf_tab = !!(fromPage.is_pdf_tab || fromUrl.is_pdf_tab);
  return c;
}

// ---------- auth + lookup ----------

let authCache = { at: 0, value: null };

async function checkAuth(force = false) {
  if (!force && Date.now() - authCache.at < 60_000 && authCache.value) return authCache.value;
  const origin = await serverOrigin();
  let value;
  if (!origin) value = { configured: false, auth: null, user: null, origin: "" };
  else {
    try {
      const me = await whoAmI();
      value = { configured: true, auth: !!me.user, user: me.user, origin, is_guest: !!me.is_guest };
    } catch (err) {
      value = { configured: true, auth: null, user: null, origin, error: err.message };
    }
  }
  authCache = { at: Date.now(), value };
  return value;
}

async function lookup(candidate) {
  if (!candidate || candidate.kind === "none") return { hit: null };
  try {
    const hit = await api("/library/lookup", {
      params: { doi: candidate.doi, arxiv_id: candidate.arxiv_id, url: candidate.pdf_url || candidate.source_url },
    });
    return { hit };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { hit: null };
    if (err instanceof ApiError && err.status === 401) return { hit: null, auth: false };
    return { hit: null, error: err.message };
  }
}

async function setDetection(tabId, candidate) {
  const st = await setTabState(tabId, { candidate, hit: null, looked: false });
  const auth = await checkAuth();
  if (!auth.configured) return st;
  if (auth.auth === false) return setTabState(tabId, { auth: false });
  const res = await lookup(candidate);
  if (res.auth === false) { authCache.at = 0; return setTabState(tabId, { auth: false, looked: true }); }
  return setTabState(tabId, { hit: res.hit, auth: true, looked: true });
}

// ---------- the save pipeline ----------

async function progress(tabId, text) {
  await setTabState(tabId, { saving: text || "" });
}

async function looksLikePdf(blob) {
  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...head).indexOf("%PDF") === 0;
}

const NOT_PDF_MSG = "this tab isn't a PDF (or the site sent a login page instead)";

// Atypon platforms (science.org & co.) serve the HTML reader at /doi/pdf/…
// unless ?download=true asks for the file itself — worth a second attempt.
function pdfUrlVariants(url) {
  const list = [url];
  try {
    const u = new URL(url);
    if (/\/doi\/e?pdf\//i.test(u.pathname) && !u.searchParams.has("download")) {
      u.pathname = u.pathname.replace(/\/doi\/epdf\//i, "/doi/pdf/");
      u.searchParams.set("download", "true");
      list.push(u.href);
    }
  } catch {}
  return list;
}

async function bytesFromTab(url, tabId) {
  // The browser's own session (institutional login, cookies) fetches what
  // the server can't. Two attempts per URL variant: the worker's direct
  // fetch, then — publisher bot checks 403 requests with an extension origin
  // and no Referer — the tab's content script, whose same-origin fetch looks
  // like the reader loading the PDF. Raw PDF tabs have no content script;
  // sendMessage fails there and the direct error stands.
  let lastErr = new Error("the browser couldn't download the PDF");
  for (const u of pdfUrlVariants(url)) {
    try {
      const res = await fetch(u, { credentials: "include" });
      if (!res.ok) throw new Error(`the browser couldn't download the PDF (${res.status})`);
      const blob = await res.blob();
      if (await looksLikePdf(blob)) return blob;
      throw new Error(NOT_PDF_MSG);
    } catch (err) {
      lastErr = err;
      console.warn(`[gamma] worker fetch failed for ${u}: ${err.message}`);
    }
    if (tabId == null) continue;
    let r = null;
    try { r = await chrome.tabs.sendMessage(tabId, { type: "fetch-pdf", url: u }); }
    catch (err) { console.warn(`[gamma] no content-script relay in tab ${tabId} (${err.message}) — is the tab reloaded?`); }
    if (r && r.ok && r.base64) {
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/pdf" });
      if (await looksLikePdf(blob)) return blob;
      lastErr = new Error(NOT_PDF_MSG);
      console.warn(`[gamma] in-page fetch of ${u} returned non-PDF bytes`);
    } else if (r && (r.status || r.error)) {
      lastErr = new Error(r.error || `the browser couldn't download the PDF (${r.status})`);
      console.warn(`[gamma] in-page fetch failed for ${u}: ${lastErr.message}`);
    }
  }
  throw lastErr;
}

async function uploadBlob(tabId, blob, url) {
  const form = new FormData();
  const name = (decodeURIComponent(url.split("?")[0].split("/").pop() || "") || "paper.pdf").replace(/\.pdf$/i, "") + ".pdf";
  form.append("file", blob, name);
  if (tabId != null) await progress(tabId, "uploading…");
  const up = await api("/uploads", { form });
  return up.doc_id;
}

async function savePaper({ tabId, candidate, folder, labels, title, source_url }) {
  const settings = await getSettings();
  const cand = candidate || { kind: "none", source_url: source_url || "" };
  const payload = {
    source_url: cand.source_url || source_url || "",
    pdf_url: cand.pdf_url || "", doi: cand.doi || "", arxiv_id: cand.arxiv_id || "",
    title: title != null ? title : (cand.title || ""),
    folder: folder != null ? folder : settings.folder,
    labels: labels != null ? labels : settings.labels,
    allow_oa: settings.allowOa, save_copy: settings.saveCopy,
  };
  // The URL this browser could download itself: the tab that *is* a PDF, or
  // the page's advertised PDF link.
  const fetchUrl = cand.pdf_url || (cand.is_pdf_tab ? cand.source_url : "");
  if (tabId != null) await progress(tabId, "resolving…");
  try {
    if (cand.is_pdf_tab && fetchUrl) {
      // The tab is the PDF — upload the bytes the browser already has access
      // to instead of making the server re-download (it may not be able to).
      // Best-effort: on failure the server-side resolve below still runs.
      try {
        if (tabId != null) await progress(tabId, "downloading in your browser…");
        payload.doc_id = await uploadBlob(tabId, await bytesFromTab(fetchUrl, tabId), fetchUrl);
      } catch (err) { console.warn(`[gamma] browser-first upload failed, server will try: ${err.message}`); }
    }
    if (tabId != null) await progress(tabId, "saving to your library…");
    let out;
    try {
      out = await api("/clip", { json: payload });
    } catch (err) {
      // The server couldn't fetch the PDF (paywall, bot check) — this
      // browser's session often can. Download here, upload, save again.
      if (!(err instanceof ApiError) || err.status !== 400 || payload.doc_id || !fetchUrl) throw err;
      if (tabId != null) await progress(tabId, "server couldn't fetch it — downloading in your browser…");
      let blob;
      try { blob = await bytesFromTab(fetchUrl, tabId); }
      catch (bErr) { throw new Error(`${err.message} The browser-side download failed too: ${bErr.message}.`); }
      payload.doc_id = await uploadBlob(tabId, blob, fetchUrl);
      if (tabId != null) await progress(tabId, "saving to your library…");
      out = await api("/clip", { json: payload });
    }
    if (tabId != null) await setTabState(tabId, { saving: "", hit: out, last: out, error: "" });
    return out;
  } catch (err) {
    const message = err.message || "save failed";
    if (tabId != null) await setTabState(tabId, { saving: "", error: message, auth: err.status === 401 ? false : undefined });
    if (err.status === 401) authCache.at = 0;
    throw err;
  }
}

async function clipSelection({ tabId, text, source_url, title }) {
  const st = tabId != null ? await getTabState(tabId) : {};
  const page_id = st.hit && st.hit.block_id || "";
  return api("/clip/note", { json: { text, source_url, title, page_id } });
}

// ---------- notifications (context menu + shortcut results) ----------

const notifyTargets = new Map();

async function notify(message, openUrl) {
  if (!chrome.notifications) return;
  const id = `gamma-${Date.now()}`;
  if (openUrl) notifyTargets.set(id, openUrl);
  try {
    await chrome.notifications.create(id, { type: "basic", iconUrl: "icons/icon128.png", title: "Gamma", message: String(message).slice(0, 300) });
  } catch {}
}

chrome.notifications && chrome.notifications.onClicked.addListener((id) => {
  const url = notifyTargets.get(id);
  if (url) chrome.tabs.create({ url });
  notifyTargets.delete(id);
  chrome.notifications.clear(id);
});

async function openInGamma(out) {
  const origin = await serverOrigin();
  return origin + (out.open_url || "/");
}

// ---------- tabs ----------

async function ensureDetection(tabId) {
  const st = await getTabState(tabId);
  if (st.candidate && st.looked) return st;
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { return st; }
  let fromPage = null;
  try { fromPage = await chrome.tabs.sendMessage(tabId, { type: "get-detection" }); } catch {}
  const candidate = mergeCandidates(fromPage, candidateFromUrl(tab.url, tab.title));
  return setDetection(tabId, candidate);
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" && info.url) {
    chrome.storage.session.remove(key(tabId));
    updateBadge(tabId, {}).catch(() => {});
  }
  if (info.status === "complete" && tab && tab.url) {
    // The content script reports first on normal pages; this fills in for PDF
    // tabs and pages where it can't run.
    setTimeout(async () => {
      const st = await getTabState(tabId);
      if (!st.candidate) setDetection(tabId, candidateFromUrl(tab.url, tab.title)).catch(() => {});
    }, 800);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "detected": {
        const tabId = sender.tab && sender.tab.id;
        if (tabId == null) return null;
        const st = await getTabState(tabId);
        const merged = mergeCandidates(msg.candidate, st.candidate && st.candidate.from_url ? st.candidate : candidateFromUrl(sender.tab.url, sender.tab.title));
        return setDetection(tabId, merged);
      }
      case "get-state": {
        const auth = await checkAuth(!!msg.forceAuth);
        let st = {};
        if (msg.tabId != null) {
          st = auth.configured && auth.auth ? await ensureDetection(msg.tabId) : await getTabState(msg.tabId);
          if (!st.candidate) {
            try { const tab = await chrome.tabs.get(msg.tabId); st.candidate = candidateFromUrl(tab.url, tab.title); } catch {}
          }
        }
        return { ...st, ...auth, settings: await getSettings() };
      }
      case "save":
        return savePaper(msg);
      case "clip-selection": {
        let text = msg.text || "";
        if (!text && msg.tabId != null) {
          try { text = (await chrome.tabs.sendMessage(msg.tabId, { type: "get-selection" })).text; } catch {}
        }
        return clipSelection({ ...msg, text });
      }
      case "auth-changed":
        authCache.at = 0;
        return checkAuth(true);
      case "open": {
        const origin = await serverOrigin();
        await chrome.tabs.create({ url: origin + (msg.path || "/") });
        return true;
      }
      default:
        return null;
    }
  })().then((r) => sendResponse({ ok: true, result: r }),
            (err) => sendResponse({ ok: false, error: err.message || String(err), status: err.status || 0 }));
  return true;
});

// ---------- context menus + keyboard command ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "gamma-save-link", title: "Save link to Gamma", contexts: ["link"] });
    chrome.contextMenus.create({ id: "gamma-save-page", title: "Save page to Gamma", contexts: ["page"] });
    chrome.contextMenus.create({ id: "gamma-clip-selection", title: "Clip selection to Gamma", contexts: ["selection"] });
  });
});

async function savePageFromTab(tab) {
  const st = await ensureDetection(tab.id);
  if (st.hit) { await notify(`Already in your library: ${st.hit.title}`, await openInGamma(st.hit)); return; }
  const cand = st.candidate || candidateFromUrl(tab.url, tab.title);
  if (cand.kind === "none") { await notify("No paper or PDF found on this page."); return; }
  try {
    const out = await savePaper({ tabId: tab.id, candidate: cand });
    await notify(`${out.existed ? "Already in your library" : "Saved"}: ${out.title}`, await openInGamma(out));
  } catch (err) {
    await notify(`Save failed: ${err.message}`);
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === "gamma-save-link") {
      const out = await savePaper({ tabId: null, candidate: candidateFromUrl(info.linkUrl, ""), source_url: info.linkUrl, title: "" });
      await notify(`${out.existed ? "Already in your library" : "Saved"}: ${out.title}`, await openInGamma(out));
    } else if (info.menuItemId === "gamma-save-page" && tab) {
      await savePageFromTab(tab);
    } else if (info.menuItemId === "gamma-clip-selection" && tab) {
      const out = await clipSelection({ tabId: tab.id, text: info.selectionText || "", source_url: tab.url, title: tab.title });
      await notify("Clipped to Gamma.", await openInGamma(out));
    }
  } catch (err) {
    await notify(`Gamma: ${err.message}`);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "save-to-gamma") return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await savePageFromTab(tab);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.server) authCache.at = 0;
});
