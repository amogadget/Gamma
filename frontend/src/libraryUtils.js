// Pure application-domain helpers. Keeping these outside App makes the rules
// usable by dialogs, home views, and future tests without coupling them to React.

export function parseFolderTags(raw) {
  return (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function cleanFolderSegment(name) {
  return (name || "").replace(/[,/]/g, " ").replace(/\s+/g, " ").trim();
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

export function getPdfPageTitle(docId, sourceUrl) {
  const tail = (sourceUrl || "").split("/").pop() || "";
  const cleaned = decodeURIComponent(tail).trim();
  return cleaned ? `PDF Notes - ${cleaned}` : `PDF Notes - ${docId}`;
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
  const doi = doiMatch
    ? decodeURIComponent(doiMatch[0])
        .replace(/[.,;)\]]+$/, "")
        .toLowerCase()
    : "";
  const arxivMatch = (url || "").match(/arxiv(?:\.org\/(?:abs|pdf)\/|[:.])(\d{4}\.\d{4,5})/i);
  const arxivId = arxivMatch ? arxivMatch[1] : "";
  if (!doi && !arxivId) return null;

  for (const page of pages || []) {
    const properties = page.properties || {};
    const metadata = properties.meta || {};
    if (doi && (metadata.doi || "").toLowerCase() === doi) return page.id;
    if (
      arxivId &&
      (metadata.arxiv_id === arxivId || (properties.source_url || "").includes(arxivId))
    )
      return page.id;
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
  for (const author of metadata.authors || []) {
    const lastName = String(author).trim().split(/\s+/).pop().toLowerCase();
    if (lastName.length > 2 && normalizedText.includes(lastName)) score += 4;
  }
  for (const word of String(metadata.title || page.content || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (word.length > 3 && words.has(word)) score += 2;
  }
  if (metadata.year && normalizedText.includes(String(metadata.year))) score += 2;
  if (metadata.volume && new RegExp(`\\b${metadata.volume}\\b`).test(normalizedText)) score += 2;
  for (const word of String(metadata.venue || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)) {
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
