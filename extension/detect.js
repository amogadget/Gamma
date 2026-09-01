// Content script: does this page hold a paper? Reads the URL, the Highwire
// citation_* meta tags (what Google Scholar reads), Dublin Core, JSON-LD and,
// as a last resort, a DOI in the visible text. Sends the candidate to the
// worker for the toolbar badge and answers the popup's "what did you find?".
// Nothing leaves the browser until the user clicks Save.

(() => {
  const DOI_RE = /10\.\d{4,9}\/[^\s"'<>?#]+/;
  const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i;
  const ARXIV_TEXT_RE = /arxiv:\s*([0-9]{4}\.[0-9]{4,5})/i;

  function meta(name) {
    const el = document.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`);
    return (el && el.content || "").trim();
  }

  function cleanDoi(text) {
    const m = (text || "").match(DOI_RE);
    if (!m) return "";
    try { return decodeURIComponent(m[0]).replace(/[.,;)\]]+$/, ""); } catch { return m[0]; }
  }

  function arxivFrom(text) {
    const m = (text || "").match(ARXIV_URL_RE) || (text || "").match(ARXIV_TEXT_RE);
    return m ? m[1] : "";
  }

  function absolute(url) {
    try { return new URL(url, location.href).href; } catch { return ""; }
  }

  function jsonLd() {
    const out = { doi: "", title: "" };
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(el.textContent);
        const items = Array.isArray(data) ? data : (data["@graph"] || [data]);
        for (const it of items) {
          const type = String(it["@type"] || "");
          if (!/Article|Scholarly|Report|Thesis|Book/i.test(type)) continue;
          const ids = [it.identifier, it.sameAs, it["@id"], it.url].flat().filter(Boolean).map(String);
          if (!out.doi) out.doi = cleanDoi(ids.find((s) => DOI_RE.test(s)) || "");
          if (!out.title && it.headline) out.title = String(it.headline);
          if (!out.title && it.name) out.title = String(it.name);
        }
      } catch {}
    }
    return out;
  }

  function detect() {
    const href = location.href;
    const isPdf = document.contentType === "application/pdf" || /\.pdf($|[?#])/i.test(location.pathname);
    const ld = jsonLd();

    let arxivId = arxivFrom(href) || arxivFrom(meta("citation_arxiv_id")) || arxivFrom(meta("citation_pdf_url"));
    let doi = "";
    if (/(?:^|\.)doi\.org$/i.test(location.hostname) || /\/doi\/(?:abs|full|pdf)?\/?10\./i.test(location.pathname)) {
      doi = cleanDoi(href);
    }
    doi = doi || cleanDoi(meta("citation_doi")) || cleanDoi(meta("dc.identifier")) || cleanDoi(meta("dc.identifier.doi"))
      || cleanDoi(meta("prism.doi")) || ld.doi;

    let pdfUrl = isPdf ? href : "";
    if (!pdfUrl) pdfUrl = absolute(meta("citation_pdf_url"));
    if (!pdfUrl) {
      const alt = document.querySelector('link[rel="alternate"][type="application/pdf"]');
      if (alt && alt.href) pdfUrl = absolute(alt.href);
    }

    let title = meta("citation_title") || ld.title || meta("dc.title") || meta("og:title") || "";
    if (!title && !isPdf) title = document.title || "";
    title = title.replace(/\s+/g, " ").trim();

    let kind = "none";
    if (pdfUrl) kind = "pdf";
    else if (arxivId) kind = "arxiv";
    else if (doi) kind = "doi";
    else {
      // Last resort: a DOI somewhere in the visible text ("possible paper").
      const text = (document.body && document.body.innerText || "").slice(0, 30000);
      const found = cleanDoi(text);
      if (found) { doi = found; kind = "maybe"; }
    }
    return { kind, source_url: href, pdf_url: pdfUrl, arxiv_id: arxivId, doi, title, is_pdf_tab: isPdf };
  }

  let last = null;
  function run() {
    try {
      last = detect();
      chrome.runtime.sendMessage({ type: "detected", candidate: last }).catch(() => {});
    } catch {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "get-detection") {
      if (!last) { try { last = detect(); } catch { last = null; } }
      sendResponse(last);
    } else if (msg && msg.type === "get-selection") {
      sendResponse({ text: String(window.getSelection && window.getSelection() || "") });
    }
  });

  run();
  // Single-page apps (OpenReview, publisher platforms) navigate without a reload.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; run(); }
  }, 1500);
})();
