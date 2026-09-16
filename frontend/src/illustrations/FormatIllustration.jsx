import React from "react";
import { FileGlyph, FileTextIcon, MarkdownIcon } from "../icons";
import obsidian from "./brands/obsidian.svg";
import logseq from "./brands/logseq.svg";
import zotero from "./brands/zotero.png";
import gamma from "./brands/gamma.svg";

const APP_ICONS = { obsidian, logseq, gamma };

// Familiar app marks and shared file icons; the card owns hover and selection.
export function FormatIllustration({ format }) {
  const appIcon = APP_ICONS[format];
  let icon;
  if (format === "zotero") icon = <img className="formatAppImage" src={zotero} alt="" width="48" height="48" />;
  else if (appIcon) icon = <span className="formatAppIcon" style={{ "--app-icon": `url("${appIcon}")` }} />;
  else if (format === "pdf" || format === "annots") icon = <FileGlyph isPdf />;
  else if (format === "markdown") icon = <MarkdownIcon size={48} strokeWidth={1.5} />;
  else icon = <FileTextIcon size={48} strokeWidth={1.5} />;
  return <span className="setPicturePreview formatIllustration" aria-hidden="true">{icon}</span>;
}
