// The anchor registry: every control the guide may point at, by id. A tour
// step names an anchor; the element carries the same id as `data-guide`.
// The guide never selects by class, text or DOM position — when a control
// moves, its attribute moves with the JSX; when it goes, delete its row here
// and the tests name every step that referenced it (docs/dev/onboarding.md).
//
// view: where the anchor exists — "home", "page" (any open page), "pdf" (a
// page with a document) or "any". open: anchors inside a closed surface list
// the anchor the engine clicks first to reveal them.

export const ANCHORS = {
  "header.home": { view: "any", description: "The Home button in the topbar" },
  "header.add": { view: "any", description: "Add — new page, PDF by URL / arXiv / DOI, uploads" },
  "header.tasks": { view: "any", description: "Background tasks (downloads, uploads, indexing)" },
  "header.search": { view: "any", description: "Workspace search (Ctrl+F)" },
  "header.share": { view: "page", description: "The page's Share button" },
  "header.account": { view: "any", description: "Account & settings menu" },
  "account.tour": { view: "any", open: ["header.account"], description: "Take the tour, in the account menu" },
  "add.urlInput": { view: "any", open: ["header.add"], description: "The Add popover's URL / arXiv / DOI box" },
  "pdf.viewer": { view: "pdf", description: "The PDF viewer" },
  "pdf.page": { view: "pdf", description: "Each rendered PDF page; supports rectangle drags" },
  "pdf.textLayer": { view: "pdf", description: "Selectable text on each rendered PDF page" },
  "pdf.highlightColor": { view: "pdf", open: ["pdf.textLayer"], description: "The first colour in the text selection palette" },
  "dock.notes": { view: "page", description: "The Notes window" },
  "notes.editor": { view: "page", open: ["dock.notes"], description: "The active note editor" },
  "page.labels": { view: "page", description: "The paper's labels" },
  "page.labelInput": { view: "page", open: ["page.labels"], description: "Add a label to this paper" },
  "chat.composer": { view: "chat", description: "The message composer and Send button" },
  "chat.context": { view: "chat", description: "Add attachments or library pages" },
  "chat.settings": { view: "chat", description: "Chat model, reasoning, context and tool settings" },
  "chat.tools": { view: "chat", description: "Enable or disable assistant tools" },
};

export const ATTR = "data-guide";

export function anchorElement(id) {
  if (!id) return null;
  return document.querySelector(`[${ATTR}="${id}"]`);
}

// Which views an anchor is expected in; used by the e2e presence check.
export function anchorsForView(view) {
  return Object.entries(ANCHORS)
    .filter(([, a]) => a.view === "any" || a.view === view || (view === "pdf" && a.view === "page"))
    .map(([id]) => id);
}
