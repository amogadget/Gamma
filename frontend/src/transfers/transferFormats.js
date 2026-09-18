// Format capabilities are independent of the dialog. Only editable options
// become switches; fixed values still reach the preview and export handler.
// What the Highlights / Notes / Bundle switches mean per format: a short hint
// under the label, the long explanation on hover. Only editable options need text.
const EXPORT_SWITCH_TEXT = {
  highlights: {
    pdf: ["Standard PDF annotations",
      "Burned in as standard PDF annotations — they survive in Acrobat, SumatraPDF, browsers."],
    notespdf: ["Quoted passages with page numbers",
      "Each highlighted passage as a quote with its page number, in the colour you highlighted it."],
    markdown: ["Blockquotes with page numbers",
      "Each highlighted passage as a blockquote with its page number."],
    obsidian: ["Quote callouts linking the PDF page",
      "Each highlighted passage as a [!quote] callout whose title opens the bundled PDF at that page."],
    zotero: ["Embedded into the exported PDF copies",
      "Written into the exported PDF copies as standard annotations — Zotero's own “Include Annotations” convention, its reader picks them up on import."],
  },
  notes: {
    pdf: ["Printed onto the page in free space",
      "Printed onto the page in nearby free space, with a line back to the highlight. Off: they stay in the annotation popups."],
    notespdf: ["Typeset under their highlights",
      "Your own writing, typeset under the highlight it belongs to — headings, lists, code, math and pasted images included."],
    markdown: ["Nested under their highlights",
      "Your own writing, nested under the highlight it belongs to."],
    obsidian: ["Headings, paragraphs and lists",
      "Your own writing as a document: top-level headings and paragraphs, deeper blocks as nested lists, mentions and synced blocks as wikilinks."],
    zotero: ["Zotero notes on each item",
      "Top-level notes become Zotero notes attached to the item; writing under a highlight travels in its annotation popup."],
  },
  bundle: {
    markdown: ["Pack the PDF and images into the .zip",
      "Pack the PDF and any pasted images into the .zip. Off: they stay as links back to this server."],
    obsidian: ["PDF and images into attachments/",
      "Put the PDF (named after its page) and any pasted images into the vault's attachments/ folder. Off: they stay as links back to this server."],
    logseq: ["Pack the PDF and images into the .zip",
      "Pack the PDF and any pasted images into the .zip. Off: they stay as links back to this server."],
    zotero: ["Include the PDF files (Zotero's “Export Files”)",
      "Pack each paper's PDF into the .zip so Zotero imports the files too. Off: metadata, collections and notes only."],
  },
};

// The rows of both dialogs, in order; a format's `category` names its row.
export const CATEGORIES = ["PDF", "Notes", "MD", "ZIP"];

const EXPORT_FORMATS = [
  { id: "pdf", label: "Annotated PDF", category: "PDF",
    hint: "Your original paper, with annotations", editable: ["highlights", "notes"], fixed: { bundle: false } },
  { id: "notespdf", label: "PDF", category: "Notes",
    hint: "A typeset document of highlights and notes", editable: ["highlights", "notes"], fixed: { bundle: false } },
  { id: "markdown", label: "Markdown", category: "Notes",
    hint: "Readable notes for any Markdown editor", editable: ["highlights", "notes", "bundle"] },
  { id: "obsidian", label: "Obsidian", category: "ZIP",
    hint: "A vault with notes, links and attachments", editable: ["highlights", "notes", "bundle"] },
  { id: "logseq", label: "Logseq", category: "ZIP",
    hint: "A graph with native PDF highlights", editable: ["bundle"], fixed: { highlights: true, notes: true } },
  { id: "zotero", label: "Zotero", category: "ZIP",
    hint: "Papers, collections and notes for Zotero", editable: ["highlights", "notes", "bundle"] },
  { id: "gamma", label: "Gamma", category: "ZIP",
    hint: "A complete copy for another Gamma library", editable: [], fixed: { highlights: true, notes: true, bundle: true } },
];

// Resolve again using the activated card's ID on double-click. Do not depend
// on React having committed a preceding selection change.
export function resolveExport(opts, { hasPdf, pdfStored, folder } = {}) {
  const formats = EXPORT_FORMATS.filter(({ id }) => id !== "pdf" || (hasPdf && !folder));
  const definition = formats.find(({ id }) => id === opts.format) || formats.find(({ id }) => id === "notespdf");
  const noPdfCopy = definition.id === "pdf" && !pdfStored;
  const values = { highlights: Boolean(opts.highlights), notes: Boolean(opts.notes), bundle: Boolean(opts.bundle), ...definition.fixed };
  if (noPdfCopy) Object.assign(values, { highlights: false, notes: false });
  // Zotero stores highlights inside the bundled PDFs, never in metadata alone.
  const withoutPdfFiles = definition.id === "zotero" && !values.bundle;
  if (withoutPdfFiles) values.highlights = false;
  const controls = (noPdfCopy ? [] : definition.editable).map((key) => ({
    key, hint: EXPORT_SWITCH_TEXT[key][definition.id][0], title: EXPORT_SWITCH_TEXT[key][definition.id][1],
    disabled: key === "highlights" && withoutPdfFiles,
  }));
  return { definition, formats, noPdfCopy, controls, needsReview: controls.some(({ disabled }) => !disabled),
    payload: { format: definition.id, ...values } };
}

export function exportSummary({ payload, noPdfCopy }, folder) {
  const { format, highlights, notes } = payload;
  switch (format) {
    case "gamma":
      return `A complete copy${folder ? " of the folder" : ""}: pages, highlights, notes, metadata, AI chats and files. Ready to import into another Gamma library.`;
    case "logseq":
      return "Highlights and notes are always included in a Logseq graph. Choose whether to include the PDF and images too.";
    case "obsidian":
      return `An Obsidian vault: one note per page${folder ? ", subfolders as folders" : ""}, links as [[wikilinks]], labels as tags${highlights ? ", highlights as quote callouts" : ""}${notes ? ", your notes as headings, paragraphs and lists" : ""}. Unzip it into a vault, or open it as one.`;
    case "pdf":
      if (noPdfCopy) return "This PDF isn't stored on the server, so only the file itself can be exported.";
      if (!highlights && !notes) return "The PDF file exactly as stored, with nothing added.";
      return `The PDF with ${highlights ? "highlight annotations" : "no annotations"}${notes ? " and every note printed onto the page" : ""}.`;
    case "notespdf":
      if (!highlights && !notes) return "A new PDF with the title and metadata only — both switches are off.";
      return `A new PDF of ${folder ? "every page in the folder" : "this page"} — title, ${highlights ? "quoted highlights" : "no quotes"}${notes ? " and your notes, typeset" : ""}.`;
    case "markdown":
      return highlights || notes
        ? `Markdown with ${highlights ? "quoted highlights" : "no quotes"}${notes ? " and your notes" : ""}.`
        : "Markdown with the title and metadata only — both switches are off.";
    default:
      return "";
  }
}

// `instructions` is the preparation note shown under a selected card.
const IMPORT_SOURCES = [
  { id: "annots", label: "Annotations in this PDF", category: "PDF", hint: "Bring embedded highlights and notes into Gamma", strip: true, actionLabel: "Import",
    instructions: "Highlights, notes and boxes saved inside this PDF (a Gamma export, SumatraPDF, Acrobat…) become regular blocks. Importing twice adds nothing — each annotation is matched to the block it already made." },
  { id: "zotero", label: "Zotero library (.zip)", category: "ZIP", hint: "Papers, collections, tags and notes", strip: true, actionLabel: "Choose .zip…" },
  { id: "markdown", label: "Markdown notes", category: "MD", hint: "Markdown files, Obsidian vaults or Notion exports", actionLabel: "Choose file…",
    instructions: "A single .md becomes a note page. A .zip of Markdown — a zipped Obsidian vault, Notion's Export → Markdown & CSV (subpages included), a Gamma Markdown export, or any zipped folder of notes — becomes one page per file: folders become folder labels, links between the notes ([[wikilinks]] included) become mentions, ![[block]] embeds synced blocks, tags labels, and images and files come along. Notes already imported are skipped." },
  { id: "logseq", label: "Logseq highlights", category: "PDF", hint: "A PDF and its .edn, with optional notes", actionLabel: "Choose files…",
    instructions: "Pick a Logseq .pdf and its .edn (a .md of notes is optional). The paper and its highlights land in your library as a new page." },
  { id: "gamma", label: "Gamma export (.zip)", category: "ZIP", hint: "Merge pages, files and chats from Gamma", actionLabel: "Choose .zip…",
    instructions: "A zip made by another Gamma's Export → Gamma format (a full backup works too). Its pages, files and chats merge into your library — nothing existing is touched, and re-importing the same zip adds nothing. (A single shared page needs no zip: paste its share link into the + menu.)" },
];

export function resolveImport(source, { hasPdf, strip } = {}) {
  const formats = IMPORT_SOURCES.filter(({ id }) => id !== "annots" || hasPdf);
  const definition = formats.find(({ id }) => id === source) || formats.find(({ id }) => id === "zotero");
  return { definition, formats, needsReview: Boolean(definition.strip),
    payload: definition.strip ? { source: definition.id, strip: Boolean(strip) } : { source: definition.id } };
}
