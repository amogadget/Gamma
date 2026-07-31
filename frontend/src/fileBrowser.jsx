// Presentational pieces for the modern file-manager home library: the
// List/Grid view switch. The large iPadOS-style tile glyphs (FolderGlyph,
// FileGlyph) live in icons.jsx with the rest of the shared icons. All
// interaction (selection, drag, rename, context menus) stays wired in
// App.jsx alongside the shared handlers.
import React from "react";
import { GridIcon, ListIcon } from "./icons";

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

export { ViewToggle };
