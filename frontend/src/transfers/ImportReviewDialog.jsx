import React from "react";
import { SubDialog } from "../settings/SettingsKit";
import { fmtBytes } from "../shared/lib/utils";
import ImportTree from "./ImportTree";
import { commitImport, discardImport, importFormat, requestImport } from "./importApi";
import { IMPORT_FILTERS, allItemIds, buildImportTree, filterImportPages, importSummary,
  importWarnings, itemSelected, resultPages, selectItems } from "./importReview";
import "./importReview.css";

const PHASE_STEP = { upload_review: 0, scanning: 0, review: 1, importing: 2, complete: 3 };
const PHASE_LABEL = { upload_review: "Uploading for review", scanning: "Checking files and library destinations",
  importing: "Importing selected items" };

export default function ImportReviewDialog({ source, file, strip, folder = "", onClose, onComplete }) {
  const format = importFormat(source, file);
  const [plan, setPlan] = React.useState(null);
  const [phase, setPhase] = React.useState("upload_review");
  const [progress, setProgress] = React.useState({ loaded: 0, total: null });
  const [selected, setSelected] = React.useState(new Set());
  const [filter, setFilter] = React.useState("all");
  const [error, setError] = React.useState("");
  const [result, setResult] = React.useState(null);
  const [attempt, setAttempt] = React.useState(0);
  const controller = React.useRef(null);
  const inFlight = React.useRef(false);
  const reviewId = React.useRef(null);
  const reportHeading = React.useRef(null);
  React.useEffect(() => {
    const ctl = new AbortController();
    controller.current = ctl;
    setError(""); setPhase("upload_review");
    requestImport({ source, file, strip, folder }, {
      signal: ctl.signal, onProgress: update => {
        if (ctl.signal.aborted) return;
        setPhase(update.phase === "upload" ? "upload_review" : "scanning");
        if (update.phase === "upload") setProgress(update);
      },
    }).then(data => {
      if (ctl.signal.aborted) return;
      reviewId.current = data.review_id;
      setPlan(data); setSelected(new Set(allItemIds(data.pages))); setPhase("review");
    }).catch(err => {
      if (!ctl.signal.aborted) { setError(err.message); setPhase("review"); }
    });
    return () => ctl.abort();
  }, [source, file, folder, strip, attempt]);
  React.useEffect(() => () => {
    controller.current?.abort();
    if (!inFlight.current) { discardImport(reviewId.current); reviewId.current = null; }
  }, []);
  React.useEffect(() => { if (phase === "complete") reportHeading.current?.focus(); }, [phase]);

  const pages = React.useMemo(() => result ? resultPages(result) : plan?.pages || [], [plan, result]);
  const shown = filterImportPages(pages, filter, selected);
  const chosenCount = pages.filter(page => itemSelected(page, selected)).length;
  const sourceTree = React.useMemo(() => buildImportTree(plan?.entries || []), [plan]);
  const destination = buildImportTree(shown, true);
  const warnings = importWarnings(result || plan || {});
  const busy = !["review", "complete"].includes(phase);
  const uploading = phase === "upload_review";
  const processingImport = phase === "importing";
  const close = () => {
    if (processingImport) return;
    controller.current?.abort(); onClose();
  };
  const submit = async () => {
    if (!plan || inFlight.current || !chosenCount) return;
    inFlight.current = true;
    const ctl = new AbortController(); controller.current = ctl;
    setError(""); setPhase("importing");
    try {
      const data = await commitImport(plan.review_id, selected, ctl.signal);
      inFlight.current = false;
      setResult(data); setFilter("all"); setPhase("complete");
      try { await onComplete?.(data, importSummary(data)); }
      catch { setError("Import finished, but the library could not refresh. Reload the library to see your items."); }
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
      setPhase("review");
    } finally { inFlight.current = false; }
  };
  const percent = progress.total ? Math.min(100, Math.floor(progress.loaded / progress.total * 100)) : null;
  return <SubDialog title={result ? "Import complete" : `Review ${format.label} import`} onClose={close}
    className="importReviewModal" closeButton={!processingImport}>
    <nav className="importStepsNav" aria-label="Import progress">
      {["Upload", "Review", "Import", "Summary"].map((label, index) => <span key={label}
        aria-current={PHASE_STEP[phase] === index ? "step" : undefined}>{index + 1}. {label}</span>)}
    </nav>
    <div className="importReviewHeader">
      <strong>{file.name}</strong><span className="importFileSize">{fmtBytes(file.size)}</span>
      {result ? <p ref={reportHeading} tabIndex={-1} role="status">{importSummary(result)}</p>
        : <p>{busy ? PHASE_LABEL[phase] : "Choose what to import and review its destination."}</p>}
    </div>
    {error ? <p role="alert" className="importWarning">{error}</p> : null}
    {busy ? <div className="importUploadProgress" role="status">
      <div><strong>{PHASE_LABEL[phase]}{uploading && percent !== null ? `… ${percent}%` : "…"}</strong>
        {uploading ? <span>{fmtBytes(progress.loaded)}{progress.total ? ` / ${fmtBytes(progress.total)}` : ` / ${fmtBytes(file.size)}`}</span>
          : <span>{phase === "scanning" ? "Upload complete. Reading the archive…" : `${chosenCount} selected items · Please keep this dialog open.`}</span>}
      </div>
      <progress aria-label={uploading ? "Upload progress" : "Import processing"} max={100} value={uploading ? percent ?? undefined : undefined} />
    </div> : null}
    {plan && !busy ? <>
      {!result ? <div className="importSelectionToolbar">
        <div role="group" aria-label="Filter import items" className="segGroup">
          {IMPORT_FILTERS.map(([value, label]) => <button key={value} type="button" className={`uiBtn sm${filter === value ? " on" : ""}`}
            aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <div className="importSelectionActions">
          <button className="uiBtn sm" onClick={() => setSelected(new Set(allItemIds(pages)))}>Select all</button>
          <button className="uiBtn sm" onClick={() => setSelected(new Set())}>Deselect all</button>
        </div>
        <p>{chosenCount} of {pages.length} items selected · {shown.length} shown{filter !== "all" ? " · Hidden selections are kept" : ""}</p>
      </div> : null}
      <div className="importReviewColumns">
        <section aria-label="ZIP contents"><h3>{/\.zip$/i.test(file.name) ? "Inside the ZIP" : "Source file"}</h3>
          <div className="importTreeScroll"><ImportTree node={sourceTree} /></div>
        </section>
        <section aria-label="Library after import"><h3>{result ? "Imported to library" : "Library after import"}</h3>
          <p className="importDestination">Library{plan.folder ? ` / ${plan.folder}` : " / All pages"}</p>
          <div className="importTreeScroll">
            {shown.length ? <ImportTree node={destination} library selected={selected} complete={Boolean(result)}
              onSelect={result ? undefined : (ids, checked) => setSelected(previous => selectItems(previous, ids, checked))} />
              : <p className="importEmpty">{result ? "No new items were added." : "No items match this filter."}</p>}
          </div>
        </section>
      </div>
      <details className="importWarnings" open={warnings.length > 0}>
        <summary>{warnings.length ? `${warnings.length} warnings — review missing or omitted content` : "No import warnings"}</summary>
        {warnings.length ? <ul>{warnings.map((warning, i) => <li key={i}><strong>{warning.title}</strong><span>{warning.reason}</span></li>)}</ul> : null}
      </details>
      {!result ? <p className="reportModalHint">{format.instructions} {source === "zotero" && strip ? "Embedded annotations will be imported and stripped from the stored PDFs." : ""}</p> : null}
    </> : null}
    <div className="reportModalBtns importReviewFooter">
      {!result && !processingImport ? <button type="button" className="uiBtn" onClick={close}>Cancel</button> : null}
      {error && !plan && !busy ? <button type="button" className="uiBtn" onClick={() => setAttempt(n => n + 1)}>Retry preview</button> : null}
      <button type="button" className="uiBtn primary" disabled={!result && (!plan || busy || !chosenCount)} onClick={result ? close : submit}>
        {result ? "Done" : phase === "importing" ? "Importing…" : "Import to library"}
      </button>
    </div>
  </SubDialog>;
}
