import React from "react";
import { FileTextIcon, PaperclipIcon } from "../icons";

// Illustrative layouts, not a render of the user's document. These elements
// follow the same effective options sent to the import/export handlers.
function PaperLines() {
  return <div className="transferPaperLines" aria-hidden="true"><i /><i /><i /><i /></div>;
}

function HighlightSample() {
  return <blockquote className="transferQuote" data-preview="highlights">
    <small>PAGE 3</small>
    <mark>A useful passage from your paper.</mark>
  </blockquote>;
}

function NoteSample({ annotation = false }) {
  return <div className={`transferNote${annotation ? " transferMarginNote" : ""}`} data-preview="notes">
    <strong>Your note</strong>
    <span>A connection worth coming back to.</span>
  </div>;
}

function Paper({ original = false, highlights, notes }) {
  return <div className={`transferPaper${original ? " transferOriginalPaper" : ""}`}>
    <div className="transferPaperTitle">Patterns in nature</div>
    <div className="transferPaperByline">A. Rivera · 2026</div>
    {original ? <><PaperLines /><div className="transferPaperFigure" aria-hidden="true"><i /><i /><i /></div></> : null}
    {highlights ? <HighlightSample /> : null}
    {notes ? <NoteSample annotation={original} /> : null}
    {original ? <PaperLines /> : null}
    <span className="transferPageNumber">1</span>
  </div>;
}

export function ExportPreview({ format, highlights, notes, bundle }) {
  const files = format !== "pdf" && format !== "notespdf";
  const metadataOnly = format === "zotero" && !bundle;
  return <figure className="transferPreview" aria-label="Export preview">
    <figcaption>Example {format === "pdf" ? "PDF page" : files ? "export" : "page layout"}</figcaption>
    <Paper original={format === "pdf"} highlights={highlights} notes={notes} />
    {format === "gamma" ? <div className="transferPreviewExtra">Metadata, page structure and AI chats included</div> : null}
    {files ? <div className="transferFiles" data-preview={bundle ? "bundled-files" : "linked-files"}>
      <PaperclipIcon size={14} />
      <div><strong>{bundle ? "Files included" : metadataOnly ? "PDF files not included" : "Files stay as links"}</strong>
        <span>{bundle ? "PDFs and images travel with the export" : metadataOnly ? "Metadata, collections and notes only" : "Links point back to this server"}</span></div>
    </div> : null}
  </figure>;
}

export function ImportPreview({ annotations, strip }) {
  return <figure className="transferPreview" aria-label="Import preview">
    <figcaption>{annotations ? "PDF after import" : "In your library"}</figcaption>
    {annotations ? <Paper original highlights={!strip} notes={false} /> : <div className="transferPaper">
      <div className="transferPaperTitle">Your imported pages</div>
      <div className="transferPaperByline">Ready to read and organize</div>
      <PaperLines /><HighlightSample /><NoteSample />
      <span className="transferPageNumber">1</span>
    </div>}
    {annotations ? <div className="transferFiles" data-preview="imported-annotations">
      <FileTextIcon size={15} /><div><strong>Highlights and notes in Gamma</strong>
        <span>{strip ? "Original annotations removed from the PDF" : "Originals kept in the PDF, hidden in the viewer"}</span></div>
    </div> : null}
  </figure>;
}
