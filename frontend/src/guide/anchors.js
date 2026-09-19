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
