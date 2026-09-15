import React from "react";
import { PageCard } from "./fileBrowser";
import { Toggle } from "./settingsKit";
import { EyeIcon, FileGlyph, FolderIcon, LabelIcon } from "./icons";

// A sample page snapshot for the real library card, kept local and decorative.
const SAMPLE_PAGE = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="416" height="260" viewBox="0 0 416 260">
  <rect width="416" height="260" fill="#e9edf1"/>
  <rect x="68" y="22" width="280" height="280" rx="4" fill="#fff"/>
  <g stroke="#52616e" stroke-linecap="round">
    <path d="M94 49h127" stroke-width="7"/>
    <path d="M94 66h87" stroke-width="4" opacity=".4"/>
    <path d="M94 90h222M94 101h204M94 112h216" stroke-width="3" opacity=".22"/>
    <path d="M94 218h222M94 229h194M94 240h208" stroke-width="3" opacity=".22"/>
  </g>
  <circle cx="169" cy="163" r="35" fill="#b6cfdd"/>
  <circle cx="214" cy="163" r="35" fill="#e2cbac" fill-opacity=".85"/>
  <path d="M208 195l36-65 36 65z" fill="#608baa" fill-opacity=".7"/>
</svg>`)}`;

export function LibraryDisplaySettings({ value }) {
  const folders = value.fileLabels === "both" || value.fileLabels === "folders";
  const labels = value.fileLabels === "both" || value.fileLabels === "labels";
  function setChips(showFolders, showLabels) {
    value.setFileLabels(showFolders ? (showLabels ? "both" : "folders") : (showLabels ? "labels" : "off"));
  }
  return <div className="libraryDisplay">
    <div className="libraryDisplayDemo">
      <figure className="libraryDisplayExample" aria-label="Library card preview">
        <figcaption>Recently viewed</figcaption>
        <PageCard className="libraryDisplayCard" title="Patterns in nature" kind="PDF" time="Just now"
          glyph={<FileGlyph />} snap={value.recentThumbs ? SAMPLE_PAGE : null}
          folders={["Reading list"]} labels={["Research"]} labelMode={value.fileLabels} />
      </figure>
      <div className="libraryDisplayControls" role="group" aria-label="Card elements">
        <div data-setting="Recents thumbnails">
          <Toggle icon={EyeIcon} label="Thumbnails" hint="Preview the page you last read."
            checked={value.recentThumbs} onChange={value.setRecentThumbs} />
        </div>
        <div data-setting="File labels">
          <Toggle icon={FolderIcon} label="Folders" hint="Show the folders a file belongs to."
            checked={folders} onChange={(on) => setChips(on, labels)} />
          <Toggle icon={LabelIcon} label="Labels" hint="Show the labels on a file."
            checked={labels} onChange={(on) => setChips(folders, on)} />
        </div>
      </div>
    </div>
    <p className="libraryDisplayHint">Thumbnails appear in Recently viewed. Folders and labels appear throughout your library.</p>
  </div>;
}
