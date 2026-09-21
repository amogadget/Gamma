import React from "react";
import { SubDialog } from "../settings/SettingsKit";
import { FileIcon, FolderIcon } from "../shared/ui/Icons";
import { API, apiJson, fmtBytes } from "../shared/lib/utils";
import "./zoteroImport.css";

function treeNode(name = "") { return { name, folders: new Map(), files: [] }; }
function folderAt(root, path) {
  let node = root;
  for (const part of path.split("/").filter(Boolean)) {
    if (!node.folders.has(part)) node.folders.set(part, treeNode(part));
    node = node.folders.get(part);
  }
  return node;
}
function archiveTree(entries) {
  const root = treeNode();
  for (const entry of entries) {
    if (entry.directory) folderAt(root, entry.path);
    else {
      const parts = entry.path.split("/");
      const name = parts.pop();
      folderAt(root, parts.join("/")).files.push({ ...entry, name });
    }
  }
  return root;
}
function libraryTree(pages) {
  const root = treeNode();
  for (const page of pages) {
    for (const folder of page.folders.length ? page.folders : [""]) {
      folderAt(root, folder).files.push({ ...page, name: page.title });
    }
  }
  return root;
}

function Tree({ node, library = false }) {
  return <ul className="zoteroTree">
    {[...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) =>
      <li key={name}><details open>
        <summary><FolderIcon size={15} /><span>{name}</span></summary>
        <Tree node={child} library={library} />
        {!child.folders.size && !child.files.length ? <span className="zoteroEmpty">Empty folder</span> : null}
      </details></li>)}
    {node.files.map((file, index) => <li key={`${file.key || file.path}-${index}`}>
      <div className="zoteroTreeFile" title={file.source_path || file.path}>
        <FileIcon size={15} />
        <div className="zoteroFileText"><span>{file.name}</span>
          {library ? <small>{file.action === "merge" ? "Update existing page" : "New page"}{file.notes ? ` · ${file.notes} exported note${file.notes === 1 ? "" : "s"}` : ""}</small>
            : <small>{fmtBytes(file.size)}{file.status === "not_imported" ? " · Not imported" : ""}</small>}
          {library && file.warnings?.length ? <small className="zoteroWarning">{file.warnings.map(w => w.reason).join(" ")}</small> : null}
        </div>
        {library ? <span className="zoteroKind">{file.kind === "pdf" ? "PDF" : "Page"}</span> : null}
      </div>
    </li>)}
  </ul>;
}

export default function ZoteroImportDialog({ file, strip, folder = "", onClose, onImport }) {
  const [plan, setPlan] = React.useState(null);
  const [error, setError] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    const body = new FormData();
    body.append("file", file);
    body.append("folder", folder);
    setError("");
    apiJson(`${API}/import/zotero/preview`, { method: "POST", body, signal: controller.signal })
      .then(setPlan).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [file, folder, attempt]);
  const source = React.useMemo(() => archiveTree(plan?.entries || []), [plan]);
  const pages = React.useMemo(() => {
    if (!result) return plan?.pages || [];
    const unique = new Map();
    for (const page of result.data.pages) {
      const prior = unique.get(page.id);
      unique.set(page.id, { ...page, action: page.created || prior?.action === "create" ? "create" : "merge" });
    }
    return [...unique.values()];
  }, [plan, result]);
  const destination = libraryTree(pages);
  const warnings = result ? [...(result.data.skipped || []), ...(result.data.warnings || [])] : plan?.warnings || [];
  const close = () => { if (!running) onClose(); };
  const submit = async () => {
    if (running || result || !plan) return;
    setRunning(true); setError("");
    try { setResult(await onImport(file, strip, plan.folder)); }
    catch (err) { setError(err.message || "Import failed. Please try again."); }
    finally { setRunning(false); }
  };
  return <SubDialog title={result ? "Import complete" : "Review Zotero import"} onClose={close} className="zoteroImportModal" closeButton={!running}>
    <div className="zoteroImportHeader">
      <strong>{file.name}</strong>
      <p>{result ? result.summary : "Review the files and their destination before adding them to your library."}</p>
      {plan && !result ? <p>{pages.filter(p => p.kind === "pdf").length} PDFs · {pages.filter(p => p.kind === "page").length} pages without PDFs · {pages.filter(p => p.action === "merge").length} updates</p> : null}
    </div>
    {error ? <p role="alert" className="zoteroWarning">{error}</p> : null}
    {!plan && !error ? <p role="status">Reading ZIP and checking attachments…</p> : null}
    {plan ? <>
      <div className="zoteroImportColumns">
        <section aria-label="ZIP contents"><h3>Inside the ZIP</h3>
          <div className="zoteroTreeScroll"><Tree node={source} /></div>
        </section>
        <section aria-label="Library after import"><h3>{result ? "Imported to library" : "Library after import"}</h3>
          <p className="zoteroDestination">Library{plan.folder ? ` / ${plan.folder}` : " / All pages"}</p>
          <div className="zoteroTreeScroll"><Tree node={destination} library /></div>
        </section>
      </div>
      <details className="zoteroWarnings" open={warnings.length > 0}>
        <summary>{warnings.length ? `${warnings.length} warnings — review missing or omitted content` : "No import warnings"}</summary>
        {warnings.length ? <ul>{warnings.map((warning, i) => <li key={i}><strong>{warning.title}</strong><span>{warning.reason}</span></li>)}</ul> : null}
      </details>
      {!result ? <p className="reportModalHint">Collections become folders. Pages in multiple collections appear in each folder. Existing pages are updated; their current PDFs are kept. {strip ? "Embedded annotations will be imported and stripped from the stored PDF." : "Embedded annotations will be imported and kept in the stored PDF."}</p> : null}
    </> : null}
    <div className="reportModalBtns zoteroImportFooter">
      {!result ? <button type="button" className="uiBtn" disabled={running} onClick={close}>Cancel</button> : null}
      {error && !plan ? <button type="button" className="uiBtn" onClick={() => setAttempt(n => n + 1)}>Retry preview</button> : null}
      <button type="button" className="uiBtn primary" disabled={!result && (!plan || running)} onClick={result ? close : submit}>
        {result ? "Done" : running ? "Importing…" : "Import to library"}
      </button>
    </div>
  </SubDialog>;
}
