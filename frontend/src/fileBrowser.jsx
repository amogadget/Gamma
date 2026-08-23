// Presentational pieces for the modern file-manager home library: the
// List/Grid view switch and the folders/files kind filter. The large
// iPadOS-style tile glyphs (FolderGlyph, FileGlyph) live in icons.jsx with
// the rest of the shared icons. All interaction (selection, drag, rename,
// context menus) stays wired in App.jsx alongside the shared handlers.
import React from "react";
import { FileIcon, FolderFilesIcon, FolderIcon, GridIcon, ListIcon } from "./icons";

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

export { ViewToggle, KindToggle };
