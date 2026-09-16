import React from "react";
import { HighlightIcon, PaperclipIcon, PenIcon, ScissorsIcon } from "./icons";
import { PictureChoices, Step, SubDialog, Toggle } from "./settingsKit";
import { ExportPreview, ImportPreview, FormatIllustration } from "./illustrations";
import { resolveExport, resolveImport, exportSummary } from "./transferFormats";

const EXPORT_CONTROLS = {
  highlights: { icon: HighlightIcon, label: "Highlights" },
  notes: { icon: PenIcon, label: "Notes" },
  bundle: { icon: PaperclipIcon, label: "Bundle the files" },
};

function FormatChoices({ label, value, onChange, onConfirm, options }) {
  return <div className="transferFormats" role="group" aria-label={label}>
    {["PDF", "Notes", "MD", "ZIP"].map((type) => {
      const group = options.filter((option) => option.category === type);
      if (!group.length) return null;
      return <section key={type} className={`transferFormatRow${group.length < 3 ? " transferFormatRowWide" : ""}`} aria-label={type}>
        <h3>{type}</h3>
        <PictureChoices label={`${type} choices`} value={value} onChange={onChange} columns={Math.min(group.length, 4)}
          onConfirm={onConfirm}
          options={group.map(({ id, label, hint }) => ({ value: id, label, hint,
            preview: <FormatIllustration format={id} />,
          }))} />
      </section>;
    })}
  </div>;
}

function TransferDialog({ title, step, setStep, firstTitle, secondTitle, onCancel, children, action, actionLabel, busy, needsReview, onContinue }) {
  const head = React.useRef(null);
  React.useEffect(() => { head.current?.focus(); }, [step]);
  return <SubDialog title={title} onClose={onCancel} className="transferModal" closeButton>
    <nav className="transferProgress" aria-label={`Step ${step + 1} of ${needsReview ? 2 : 1}`}>
      {step > 0 ? <button type="button" className="crumbBtn" onClick={() => setStep(0)}>1. {firstTitle}</button>
        : <span aria-current="step">{needsReview ? "1. " : ""}{firstTitle}</span>}
      {needsReview ? <><span aria-hidden="true">/</span>
      <span aria-current={step === 1 ? "step" : undefined}>2. Review</span></> : null}
    </nav>
    <div className="transferStep" key={step}>
      <h2 ref={head} tabIndex={-1}>{step === 0 ? firstTitle : secondTitle}</h2>
      {children}
    </div>
    <div className="reportModalBtns transferFooter">
      <button type="button" className="uiBtn primary" disabled={busy}
        onClick={step === 0 ? onContinue : action}>{step === 0 && needsReview ? "Next" : actionLabel}</button>
    </div>
  </SubDialog>;
}

export function ExportDialog({ opts, setOpts, hasPdf, pdfStored, folder, onCancel, onExport }) {
  const [step, setStep] = React.useState(0);
  const context = { hasPdf, pdfStored, folder };
  const resolved = resolveExport(opts, context);
  const { definition, formats, controls, needsReview, payload } = resolved;
  const { format, highlights, bundle } = payload;
  const isZotero = format === "zotero";
  const set = (patch) => setOpts((o) => ({ ...o, ...patch }));
  const advance = (id = format) => {
    const next = resolveExport({ ...opts, format: id }, context);
    set({ format: next.payload.format });
    if (next.needsReview) setStep(1);
    else onExport(next.payload);
  };
  const summary = exportSummary(resolved, folder);

  return <TransferDialog title={folder ? `Export “${folder}”` : "Export"} step={step} setStep={setStep}
    firstTitle="Choose a format" secondTitle={definition.label} needsReview={needsReview} onContinue={() => advance()}
    onCancel={onCancel} actionLabel="Export" action={() => onExport(payload)}>
    {step === 0 ? <>
      <p className="reportModalHint">{needsReview ? "Select a format. Double-click to continue." : "Ready to export."}</p>
      <FormatChoices label="Export format" value={format} onChange={(format) => set({ format })} onConfirm={advance} options={formats} />
      {!needsReview ? <p className="reportModalHint">{summary}</p> : null}
    </> : <>
      <p className="reportModalHint">Choose what to include.</p>
      <div className="transferReview">
        <ExportPreview {...payload} />
        <div className="transferControls">
          {controls.map(({ key, hint, title, disabled }) => {
            const { icon, label } = EXPORT_CONTROLS[key];
            return <Toggle key={key} icon={icon} label={label} hint={hint} title={title}
              checked={payload[key]} disabled={disabled} onChange={(value) => set({ [key]: value })} />;
          })}
          {isZotero && !bundle ? <p className="reportModalHint">Highlights travel inside PDF files. Turn on file bundling to include them.</p> : null}
        </div>
      </div>
      {isZotero ? (
        // Same numbered-step guide as the Zotero import dialog — the .zip
        // trap (Zotero can't read one) is worth spelling out every time.
        <details className="transferHelp"><summary>Open this export in Zotero</summary><div className="importSteps">
          <Step n={1} title="Download the .zip"
            hint={`Metadata, ${folder ? "subfolders" : "folders"} as collections, tags, notes${bundle ? `; the PDF${folder ? "s" : ""}${highlights ? " with highlights embedded" : ""} and note images` : ""}.`} />
          <Step n={2} title="Unzip it"
            hint="Keep the .rdf and the files/ folder together." />
          <Step n={3} title="Import the .rdf in Zotero"
            hint={'File → Import… → "A file" → pick the .rdf — never the .zip (Zotero calls it an unsupported format). Untick "Place imported collections… into a new collection" to skip the extra wrapper folder.'} />
        </div></details>
      ) : (
        <div className="reportModalHint">{summary}</div>
      )}
    </>}
  </TransferDialog>;
}

// The import counterpart of ExportDialog, same shape: pick a source, flip the
// switch that source understands, confirm. Nothing here is remembered — the
// strip switch starts from the Settings preference every time, so the setting
// stays the standing policy and the dialog is only ever a one-off override.
export function ImportDialog({ hasPdf, stripDefault, busy, onCancel, onImport }) {
  const [step, setStep] = React.useState(0);
  // Zotero is the default source; with a PDF open, that PDF's own annotations
  // are the more likely intent and win instead.
  const [source, setSource] = React.useState(hasPdf ? "annots" : "zotero");
  const [strip, setStrip] = React.useState(stripDefault);
  const { definition, formats, needsReview, payload } = resolveImport(source, { hasPdf, strip });
  const src = definition.id;
  const advance = (id = src) => {
    if (busy) return;
    const next = resolveImport(id, { hasPdf, strip });
    setSource(next.definition.id);
    if (next.needsReview) setStep(1);
    else onImport(next.payload);
  };
  return <TransferDialog title="Import" step={step} setStep={setStep} onCancel={onCancel} busy={busy}
    firstTitle="Choose a source" secondTitle={definition.label} needsReview={needsReview} onContinue={() => advance()}
    actionLabel={definition.actionLabel} action={() => onImport(payload)}>
    {step === 0 ? <>
      <p className="reportModalHint">Choose a source. Double-click to continue, or use the button below.</p>
      <FormatChoices label="Import from" value={src} onChange={setSource} onConfirm={busy ? undefined : advance} options={formats} />
      {!needsReview ? <p className="reportModalHint">{definition.instructions}</p> : null}
    </> : <>
      <div className="transferReview">
        <ImportPreview annotations strip={payload.strip} />
        <div className="transferControls">
          <Toggle
            icon={ScissorsIcon}
            label="Strip the originals"
            hint={src === "annots" ? "Rewrite the stored PDF without them" : "Rewrite the imported PDFs without them"}
            title="Rewrite the stored file without the annotations you're importing, so only Gamma's copies remain. Off: they stay in the file and the viewer hides them."
            checked={payload.strip}
            onChange={setStrip}
          />
        </div>
      </div>
      {src === "zotero" ? (
        // Same numbered-step guide as the add-API-key wizard.
        <div className="importSteps">
          <Step n={1} title="Export from Zotero"
            hint={'File → Export Library… (or right-click a collection), format "Zotero RDF".'} />
          <Step n={2} title="Include the files and notes"
            hint={'Check "Export Files" and "Export Notes" — the files carry your PDFs and the annotations you made in Zotero\'s reader.'} />
          <Step n={3} title="Zip the exported folder and pick it here"
            hint="Papers arrive with their metadata; collections become folders, tags labels, notes blocks. Importing again updates instead of duplicating." />
        </div>
      ) : (
        <div className="reportModalHint">{definition.instructions}</div>
      )}
    </>}
  </TransferDialog>;
}
