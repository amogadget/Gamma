import React from "react";
import { sampleLibraryPage } from "../shared/illustrations";
import { PageCard } from "../library/FileBrowser";
import { Toggle } from "./SettingsKit";
import { EyeIcon, FileGlyph, FolderIcon, LabelIcon } from "../shared/ui/Icons";

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
          glyph={<FileGlyph />} snap={value.recentThumbs ? sampleLibraryPage : null}
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
