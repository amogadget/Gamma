import React from "react";
import { FileIcon, FolderIcon } from "../shared/ui/Icons";
import { fmtBytes } from "../shared/lib/utils";
import { itemIds, treeItemIds } from "./importReview";

function SelectionBox({ ids, selected, onSelect, label }) {
  const ref = React.useRef(null);
  const count = ids.filter(id => selected.has(id)).length;
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = count > 0 && count < ids.length; }, [count, ids.length]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={count === ids.length && count > 0}
    onChange={event => onSelect(ids, event.target.checked)} />;
}
export default function ImportTree({ node, library = false, selected, onSelect, complete = false }) {
  return <ul className="importTree">
    {[...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) =>
      <li key={name}><details open>
        <summary>{onSelect ? <SelectionBox ids={treeItemIds(child)} selected={selected} onSelect={onSelect} label={`Select folder ${name}`} /> : null}
          <FolderIcon size={15} /><span>{name}</span></summary>
        <ImportTree node={child} library={library} selected={selected} onSelect={onSelect} complete={complete} />
        {!child.folders.size && !child.files.length ? <span className="importEmpty">Empty folder</span> : null}
      </details></li>)}
    {node.files.map((file, index) => <li key={`${file.id || file.key || file.path}-${index}`}>
      <div className="importTreeFile" title={file.source_path || file.path}>
        {onSelect ? <SelectionBox ids={itemIds(file)} selected={selected} onSelect={onSelect} label={`Import ${file.name}`} /> : null}
        <FileIcon size={15} />
        <div className="importFileText"><span>{file.name}</span>
          {library ? <small>{file.action === "skip" ? "Already in library" : file.action === "merge" ? (complete ? "Updated" : "Update existing page") : (complete ? "Imported" : "New page")}
            {file.notes ? ` · ${file.notes} exported note${file.notes === 1 ? "" : "s"}` : ""}</small>
            : <small>{fmtBytes(file.size)}{file.status === "not_imported" ? " · Not imported" : ""}</small>}
          {library && file.warnings?.length ? <small className="importWarning">{file.warnings.map(w => w.reason).join(" ")}</small> : null}
        </div>
        {library ? <span className="importKind">{file.kind === "pdf" ? "PDF" : file.kind === "chat" ? "Chat" : "Page"}</span> : null}
      </div>
    </li>)}
  </ul>;
}
