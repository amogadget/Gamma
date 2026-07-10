// Presentational pieces for the modern file-manager home library: the
// List/Grid view switch and the large iPadOS-style icon glyphs used by the
// grid tiles and pinned strip. All interaction (selection, drag, rename,
// context menus) stays wired in App.jsx alongside the shared handlers.
import React from "react";

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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
      </button>
      <button
        className={`homeViewBtn ${view === "grid" ? "active" : ""}`}
        onClick={() => onChange("grid")}
        title="Grid view"
        aria-pressed={view === "grid"}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></svg>
      </button>
    </div>
  );
}

// Big folder glyph for grid tiles (filled, accent-colored via CSS).
function FolderGlyph() {
  return (
    <svg className="tileGlyph folderGlyph" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
    </svg>
  );
}

// Big file glyph — a document sheet with a folded corner. A PDF-backed page
// gets a small "PDF" tab so it reads as an annotated paper at a glance.
function FileGlyph({ isPdf }) {
  return (
    <svg className="tileGlyph fileGlyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="var(--bg-raised)" />
      <path d="M14 2v6h6" />
      {isPdf ? (
        <text x="12" y="17" textAnchor="middle" fontSize="5" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
      ) : (
        <>
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </>
      )}
    </svg>
  );
}

export { ViewToggle, FolderGlyph, FileGlyph };
