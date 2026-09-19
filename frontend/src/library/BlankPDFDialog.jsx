// "New blank PDF": a notebook page with its own document, made for handwriting
// (see docs/design/blank-pdf-pages.md in the native branch / the blank_pdf
// router). It deliberately creates an ordinary Gamma library page carrying an
// immutable PDF source — never a second library, and never an insertion into
// an existing document.
//
// The creation id is minted ONCE per attempt and reused on retry: the endpoint
// is idempotent by that id, so a lost response cannot produce a second
// notebook. That is also why every field locks as soon as a request has been
// sent — the retry must carry the exact same payload.
import React, { useRef, useState } from "react";

function creationID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function BlankPDFDialog({ folder, onCreate, onClose }) {
  const [title, setTitle] = useState("Blank PDF"), [pageSize, setPageSize] = useState("a4");
  const [orientation, setOrientation] = useState("portrait"), [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // {id, body} of the request in flight (or the one that failed): a retry
  // repeats it verbatim.
  const pending = useRef(null);
  const valid = !!title.trim() && Number.isInteger(pages) && pages >= 1 && pages <= 100;
  async function submit(event) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    setError("");
    try {
      if (!pending.current) {
        pending.current = { id: creationID(), body: { title: title.trim(), page_size: pageSize, orientation, page_count: pages, folder } };
      }
      await onCreate(pending.current.id, pending.current.body);
    } catch (err) {
      setError(err.message || "Creation failed. Retry reuses the same document ID.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="reportOverlay" data-popover="blank-pdf" onKeyDown={(event) => {
      // The dialog owns its keys: Escape closes it (unless a request is in
      // flight) and Tab cycles inside it instead of reaching the page behind.
      event.stopPropagation();
      if (event.key === "Escape" && !busy) onClose();
      if (event.key === "Tab") {
        const items = [...event.currentTarget.querySelectorAll("input:not(:disabled),select:not(:disabled),button:not(:disabled)")];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    }}>
      <form className="reportModal confirmModal blankPDFModal" role="dialog" aria-modal="true" aria-labelledby="blank-pdf-title" onSubmit={submit}>
        <div className="reportModalTitle" id="blank-pdf-title">New blank PDF</div>
        <p className="confirmMessage">A separate PDF notebook in your Gamma library, ready for handwriting. This does not change any existing PDF.</p>
        <label>Title<input autoFocus required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy || !!pending.current} /></label>
        <label>Paper size
          <select aria-label="Paper size" value={pageSize} onChange={(e) => setPageSize(e.target.value)} disabled={busy || !!pending.current}>
            <option value="a4">A4</option>
            <option value="letter">US Letter</option>
          </select>
        </label>
        <label>Orientation
          <select aria-label="Orientation" value={orientation} onChange={(e) => setOrientation(e.target.value)} disabled={busy || !!pending.current}>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </label>
        <label>Pages<input type="number" min={1} max={100} step={1} required value={pages}
          onChange={(e) => setPages(Number(e.target.value))} disabled={busy || !!pending.current} /></label>
        {folder ? <div className="confirmMessage">Folder: {folder}</div> : null}
        {error ? (
          <div role="alert" className="confirmMessage">
            {error}<br />Retry uses the same request; close and refresh the library if unsure whether creation succeeded.
          </div>
        ) : null}
        <div className="reportModalBtns">
          <button type="button" className="uiBtn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="uiBtn primary" disabled={busy || !valid}>
            {busy ? "Creating…" : pending.current ? "Retry" : "Create PDF"}
          </button>
        </div>
      </form>
    </div>
  );
}
