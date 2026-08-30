// Presentational pieces for the modern file-manager home library: the shared
// page/folder card, the folder+label chip strip, the List/Grid view switch and
// the folders/files kind filter. The large iPadOS-style tile glyphs
// (FolderGlyph, FileGlyph) live in icons.jsx with the rest of the shared
// icons. All interaction (selection, drag, rename, context menus) stays wired
// in App.jsx alongside the shared handlers.
import React from "react";
import { FileIcon, FolderFilesIcon, FolderIcon, GridIcon, ListIcon, LabelIcon } from "./icons";

// Folder + label chips for a page, filtered by the Settings → General "File
// labels" preference ("off" | "labels" | "folders" | "both"). Purely
// informational — chips don't navigate; `onLabelMenu(name)` optionally wires
// the label rename/delete context menu where the caller offers one. `reserve`
// keeps an empty chip line when there is nothing to show, so grid cards with
// and without tags keep the same footer geometry.
function CardLabels({ folders, labels, mode = "both", onLabelMenu, reserve = false, className = "cardLabels" }) {
  const showFolders = (mode === "both" || mode === "folders") && folders?.length > 0;
  const showLabels = (mode === "both" || mode === "labels") && labels?.length > 0;
  if (!showFolders && !showLabels) return reserve ? <span className={className} /> : null;
  return (
    <span className={className}>
      {showFolders ? folders.map((f) => (
        <span key={`f:${f}`} className="folderTagBadge" title={`In folder ${f}`}>
          <FolderIcon size={10} />
          {f}
        </span>
      )) : null}
      {showLabels ? labels.map((l) => (
        <span
          key={`l:${l}`}
          className="labelTagBadge"
          title={onLabelMenu ? `Label: ${l} — right-click to rename or delete` : `Label: ${l}`}
          onContextMenu={onLabelMenu ? onLabelMenu(l) : undefined}
        >
          <LabelIcon size={10} />
          {l}
        </span>
      )) : null}
    </span>
  );
}

// The one home-library card: a cover (page snapshot when available, else the
// file/folder glyph) over a bottom-stuck footer of title + labels + kind/time.
// Used by the Recently-viewed carousel, the category carousel and the grid
// listing — the container decides the size (fixed width in a carousel, fluid
// grid track in .fileGrid). Purely presentational: click/drag/context-menu
// handlers arrive via rootProps, overlay buttons (pin, remove ×) and rename
// inputs as nodes.
function PageCard({
  glyph, snap, title, tip, renameNode, kind, count, time,
  folders, labels, labelMode, onLabelMenu, reserveLabels = false,
  className = "", children, ...rootProps
}) {
  return (
    <div className={`pageCard ${className}`} title={tip || title} {...rootProps}>
      <div className="pageCardCover">
        {snap ? <img src={snap} alt="" draggable={false} /> : glyph}
      </div>
      <div className="pageCardBody">
        {renameNode || <div className="pageCardTitle">{title || "Untitled"}</div>}
        <CardLabels folders={folders} labels={labels} mode={labelMode} onLabelMenu={onLabelMenu} reserve={reserveLabels} />
        {kind || count != null || time ? (
          <div className="pageCardMeta">
            {kind ? <span className="pageCardKind">{kind}</span> : null}
            {count != null ? <span className="pageCardCount">{count}</span> : null}
            <span className="pageCardTime">{time}</span>
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// List / Grid segmented control.
function ViewToggle({ view, onChange }) {
  return (
    <div className="homeViewToggle" role="group" aria-label="View mode">
      <button
        className={`homeViewBtn ${view === "list" ? "active" : ""}`}
        onClick={() => onChange("list")}
        title="List view"
        aria-pressed={view === "list"}
      >
        <ListIcon size={15} />
      </button>
      <button
        className={`homeViewBtn ${view === "grid" ? "active" : ""}`}
        onClick={() => onChange("grid")}
        title="Grid view"
        aria-pressed={view === "grid"}
      >
        <GridIcon size={15} />
      </button>
    </div>
  );
}

// What the listing shows: folders + files, folders only, or files only.
function KindToggle({ value, onChange }) {
  const kinds = [
    ["all", "Folders & files", FolderFilesIcon],
    ["folders", "Folders only", FolderIcon],
    ["files", "Files only", FileIcon],
  ];
  return (
    <div className="homeViewToggle" role="group" aria-label="Shown items">
      {kinds.map(([val, label, Icon]) => (
        <button
          key={val}
          className={`homeViewBtn ${value === val ? "active" : ""}`}
          onClick={() => onChange(val)}
          title={label}
          aria-pressed={value === val}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}

export { ViewToggle, KindToggle, CardLabels, PageCard };
