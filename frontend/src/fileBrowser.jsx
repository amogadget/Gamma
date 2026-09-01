// Presentational pieces for the modern file-manager home library: the shared
// page/folder card, the folder+label chip strip, the List/Grid view switch and
// the folders/files kind filter. The large iPadOS-style tile glyphs
// (FolderGlyph, FileGlyph) live in icons.jsx with the rest of the shared
// icons. All interaction (selection, drag, rename, context menus) stays wired
// in App.jsx alongside the shared handlers.
import React from "react";
import { FileIcon, FolderFilesIcon, FolderIcon, GridIcon, ListIcon, LabelIcon, SearchIcon } from "./icons";

// Folder + label chips for a page, filtered by the Settings → General "File
// labels" preference ("off" | "labels" | "folders" | "both"). Purely
// informational — chips don't navigate; `onLabelMenu(name)` optionally wires
// the label rename/delete context menu where the caller offers one. With the
// chips enabled the span always renders, empty or not: on a card it is the
// reserved chip line that keeps every footer the same height.
function CardLabels({ folders, labels, mode = "both", onLabelMenu, className = "cardLabels" }) {
  if (mode === "off") return null;
  const showFolders = (mode === "both" || mode === "folders") && folders?.length > 0;
  const showLabels = (mode === "both" || mode === "labels") && labels?.length > 0;
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
// Used by every card surface — both carousels, the pinned strip and the grid
// listing — and it renders the SAME geometry everywhere; the container only
// decides the width (fixed in a carousel, fluid grid track in .fileGrid).
// Purely presentational: click/drag/context-menu handlers arrive via
// rootProps, overlay buttons (pin, remove ×) and rename inputs as nodes.
function PageCard({
  glyph, snap, title, tip, renameNode, kind, count, time,
  folders, labels, labelMode, onLabelMenu,
  className = "", children, ...rootProps
}) {
  return (
    <div className={`pageCard ${className}`} title={tip || title} {...rootProps}>
      <div className="pageCardCover">
        {snap ? <img src={snap} alt="" draggable={false} /> : glyph}
      </div>
      <div className="pageCardBody">
        {renameNode || <div className="pageCardTitle">{title || "Untitled"}</div>}
        <CardLabels folders={folders} labels={labels} mode={labelMode} onLabelMenu={onLabelMenu} />
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

// What the listing shows: folders + files, folders only, files only, or the
// labels in scope (labels browse exactly like folders — see LabelRow/openLabel
// in App.jsx).
function KindToggle({ value, onChange, scopeLabel }) {
  const kinds = [
    ["all", "Folders & files", FolderFilesIcon],
    ["folders", "Folders only", FolderIcon],
    ["files", "Files only", FileIcon],
    ["labels", "Labels", LabelIcon],
  ];
  return (
    <div className="homeViewToggle" role="group" aria-label={scopeLabel || "Shown items"} title={scopeLabel || undefined}>
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

// Listing search box: matching items float to the top of the current sort,
// the rest stay put but dimmed. Live as you type — the caller debounces
// nothing, the listing is already memoized.
function ListFindBox({ value, onChange, placeholder = "Search…" }) {
  return (
    <div className={`homeFindBox ${value ? "active" : ""}`}>
      <SearchIcon size={13} />
      <input
        className="homeFindInput"
        value={value}
        placeholder={placeholder}
        aria-label="Search this listing"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.stopPropagation(); onChange(""); } }}
      />
      {value ? (
        <button className="uiClose uiCloseSm homeFindClear" title="Clear search" aria-label="Clear search" onClick={() => onChange("")}>×</button>
      ) : null}
    </div>
  );
}

export { ViewToggle, KindToggle, ListFindBox, CardLabels, PageCard };
