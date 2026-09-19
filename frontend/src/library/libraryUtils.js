// Pure application-domain helpers. Keeping these outside App makes the rules
// usable by dialogs, home views, and future tests without coupling them to React.

export function parseFolderTags(raw) {
  return (raw || "").split(",").map((value) => value.trim()).filter(Boolean);
}

// The library's "pages without a label" view is a pseudo-label: this sentinel
// stands in for it wherever a label name flows (categoryFilter, the label
// tiles, the per-view sort/kind pref keys). A real label can never contain a
// comma — parseFolderTags splits on it — so it cannot collide with one.
export const NO_LABEL = ",none";
export const NO_LABEL_TITLE = "No label";
export const labelTitle = (name) => (name === NO_LABEL ? NO_LABEL_TITLE : name);

export function cleanFolderSegment(name) {
  return (name || "").replace(/[,/]/g, " ").replace(/\s+/g, " ").trim();
}

// Normalize a typed folder path: "cs229/" → "cs229", " cs229 / hw " → "cs229/hw".
export function cleanFolderPath(path) {
  return (path || "").split("/").map(cleanFolderSegment).filter(Boolean).join("/");
}

// Add a folder path to a page's folder tags (a soft link — other tags are
// kept). The only tag removed is an ancestor of the new path: refining
// "readout" into "readout/nondestructive" shouldn't leave both levels.
export function addFolderTag(tags, path) {
  return [...tags.filter((t) => t !== path && !path.startsWith(t + "/")), path];
}

export function formatRelativeTime(iso, now = Date.now()) {
  if (!iso) return "";
  const then = new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  const secs = Math.max(1, Math.floor((now - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// The page's attachment — today the single PDF slot (`properties.doc_id` +
// `source_url` / `original_filename`). Every "what does this page carry"
// decision (layout, card badge, gating, copy) reads THIS, never the raw
// properties, so a later `properties.attachments` list is a drop-in
// (docs/dev/block_centric.md). Null for a page that is only blocks.
export function pageAttachment(block) {
  const p = block?.properties || {};
  if (!p.doc_id && !p.source_url) return null;
  return { kind: "pdf", id: p.doc_id || "", url: p.source_url || "", name: p.original_filename || "" };
}

// Where the attachment's file is fetched from: its source URL (a local
// upload already points at /api/uploads/…), else the stored copy by hash.
export function attachmentSource(attachment) {
  if (!attachment) return "";
  return attachment.url || (attachment.id ? `/api/uploads/${attachment.id}.pdf` : "");
}

// What a card/row says a page is: the attachment kind, else just a page.
export function pageKindLabel(attachment) {
  return attachment ? "PDF" : "Page";
}

// Title for a page whose title is empty: the attachment's file name or URL
// tail, else "Untitled". (The old "PDF Notes - …" prefix is gone; existing
// pages were normalized by `manage.py migrate`.)
export function defaultPageTitle(attachment) {
  if (!attachment) return "Untitled";
  if (attachment.name) return attachment.name;
  const tail = (attachment.url || "").split("/").pop() || "";
  let cleaned = tail;
  try { cleaned = decodeURIComponent(tail); } catch {}
  return cleaned.trim() || "Untitled";
}

export function metadataToDraft(metadata) {
  return {
    title: metadata?.title || "",
    authors: (metadata?.authors || []).join(", "),
    venue: metadata?.venue || "",
    year: metadata?.year || "",
    volume: metadata?.volume || "",
    pages: metadata?.pages || "",
    doi: metadata?.doi || "",
    arxiv_id: metadata?.arxiv_id || "",
    publisher: metadata?.publisher || "",
    isbn: metadata?.isbn || "",
  };
}

export function friendlyApiError(error) {
  const message = error?.message || "failed";
  return /Unexpected token|Method Not Allowed|not valid JSON/i.test(message)
    ? "endpoint missing — restart/update the server"
    : message.slice(0, 120);
}

export function findPageForUrl(url, pages) {
  const doiMatch = (url || "").match(/10\.\d{4,9}\/[^\s?#]+/);
  const doi = doiMatch ? decodeURIComponent(doiMatch[0]).replace(/[.,;)\]]+$/, "").toLowerCase() : "";
  const arxivMatch = (url || "").match(/arxiv(?:\.org\/(?:abs|pdf)\/|[:.])(\d{4}\.\d{4,5})/i);
  const arxivId = arxivMatch ? arxivMatch[1] : "";
  if (!doi && !arxivId) return null;

  for (const page of pages || []) {
    const properties = page.properties || {};
    const metadata = properties.meta || {};
    if (doi && (metadata.doi || "").toLowerCase() === doi) return page.id;
    if (arxivId && (metadata.arxiv_id === arxivId || (properties.source_url || "").includes(arxivId))) return page.id;
    if (doi && (properties.source_url || "").toLowerCase().includes(doi)) return page.id;
  }
  return null;
}

export function scorePaperMatch(text, page) {
  const normalizedText = (text || "").toLowerCase();
  if (!normalizedText) return 0;
  const words = new Set(normalizedText.split(/[^a-z0-9]+/).filter((word) => word.length > 3));
  const metadata = page.properties?.meta || {};
  let score = 0;
  if (metadata.doi && normalizedText.includes(String(metadata.doi).toLowerCase())) score += 20;
  if (metadata.arxiv_id && normalizedText.includes(metadata.arxiv_id)) score += 20;
  for (const author of (metadata.authors || [])) {
    const lastName = String(author).trim().split(/\s+/).pop().toLowerCase();
    if (lastName.length > 2 && normalizedText.includes(lastName)) score += 4;
  }
  for (const word of String(metadata.title || page.content || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length > 3 && words.has(word)) score += 2;
  }
  if (metadata.year && normalizedText.includes(String(metadata.year))) score += 2;
  if (metadata.volume && new RegExp(`\\b${metadata.volume}\\b`).test(normalizedText)) score += 2;
  for (const word of String(metadata.venue || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)) {
    if (word.length > 2 && normalizedText.includes(word)) score += 1;
  }
  return score;
}

export function normalizeLinkInput(value) {
  const input = (value || "").trim();
  if (!input) return "";
  if (/^https?:\/\//i.test(input)) return input;
  if (/^arxiv:/i.test(input)) return `https://arxiv.org/abs/${input.slice(6).trim()}`;
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(input)) return `https://arxiv.org/abs/${input}`;
  return `https://doi.org/${input.replace(/^doi:\s*/i, "")}`;
}
