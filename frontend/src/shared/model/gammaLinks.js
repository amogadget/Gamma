// Links into a Gamma library, written as ordinary markdown: the AI's
// citations (`/?page=<id>&pdf_page=3&quote=…`), the ⋮⋮ menu's "copy link"
// (`?block=<id>`) and a page link (`/?page=<id>`). One classifier for the
// chat, the rendered notes and the "Paste as" chooser — they used to detect
// these three different ways and disagreed about what counted.
//
// The ORIGIN is deliberately not part of the test: a server moves (a desktop
// sidecar on 127.0.0.1, a NAS URL, a workspace mirrored onto another server),
// and a link pasted before the move still names the pages of this library.
// The caller confirms by resolving the id locally — a link to somebody else's
// Gamma simply doesn't resolve and stays an external link. Ids are random.

const ID_RE = /^[a-zA-Z0-9_-]+$/;

// href → { kind: "block" | "page" | "citation", … } | null.
//   block:    { kind, blockId }
//   page:     { kind, pageId }
//   citation: { kind, pageId, page, quote }   — quote "" means "just open page N"
// `foreign` marks a link written against a different host than this tab's.
export function parseGammaLink(href, origin = "http://localhost") {
  if (!href) return null;
  let url;
  try { url = new URL(href, origin); } catch { return null; }
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const foreign = /^https?:\/\//i.test(href) && url.origin !== origin;

  const blockId = url.searchParams.get("block");
  if (blockId) return ID_RE.test(blockId) ? { kind: "block", blockId, foreign } : null;

  const pageId = url.searchParams.get("page");
  if (!pageId || !ID_RE.test(pageId)) return null;

  const rawPage = url.searchParams.get("pdf_page");
  if (rawPage == null) return { kind: "page", pageId, foreign };
  const page = Number(rawPage);
  if (!Number.isSafeInteger(page) || page < 1 || page > 5000) return null;
  const quote = url.searchParams.get("quote") || "";
  // A quote is optional (open the page), but a present one must be usable:
  // too short to identify a passage, or too long to have been copied, is a
  // malformed link rather than a page pointer.
  if (quote && (quote.trim().length < 8 || quote.length > 2000)) return null;
  return { kind: "citation", pageId, page, quote, foreign };
}

// The page/block this link points at, for resolving a label against the
// library (the same lookup [[ref]] chips use).
export function gammaLinkId(link) {
  return link ? (link.kind === "block" ? link.blockId : link.pageId) : null;
}

// Drop the origin and the workspace so a pasted link is stored host-free —
// notes written today keep working after the server moves. Relative input is
// returned unchanged apart from `ws`.
export function relativeGammaLink(href, origin = "http://localhost") {
  let url;
  try { url = new URL(href, origin); } catch { return href; }
  url.searchParams.delete("ws");
  return `/${url.search}`;
}

// The page/block ids a markdown source links to — what a renderer must
// resolve before it can label (and claim) those links. Markdown link targets
// plus bare URLs (remark autolinks those, so they render as links too).
export function gammaLinkIds(text) {
  const out = [];
  const targets = /]\(([^)\s]+)\)|(^|\s)(https?:\/\/\S+|\/?\?\S+)/g;
  for (const m of String(text || "").matchAll(targets)) {
    const id = gammaLinkId(parseGammaLink(m[1] || m[3]));
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
