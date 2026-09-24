import { API, apiJson } from "../shared/lib/utils";
import { xhrUpload } from "../shared/lib/xhrUpload";

const FORMATS = {
  zotero: { label: "Zotero", endpoint: "zotero", instructions: "Collections become folders. Additional PDFs become separate pages. Existing PDFs are kept." },
  markdown: { label: "Markdown", endpoint: "markdown-zip", instructions: "Notes become pages; linked files travel with the selected notes. Links to deselected notes stay as written." },
  gamma: { label: "Gamma", endpoint: "gamma", instructions: "Selected pages include their notes, attachments and chats. Pages already in your library are kept unchanged." },
};
export function importFormat(source, file) {
  const format = FORMATS[source];
  if (!format) throw new Error("Unsupported import source");
  return source === "markdown" && !/\.zip$/i.test(file.name) ? { ...format, endpoint: "markdown-file" } : format;
}
// `onProgress` gets {phase: "upload", loaded, total} while the bytes go up,
// then {phase: "processing"} while the server reads the archive.
export function requestImport({ source, file, folder = "", strip }, { signal, onProgress } = {}) {
  const format = importFormat(source, file);
  const body = new FormData();
  body.append("file", file);
  body.append("source", format.endpoint);
  if (source !== "gamma") body.append("folder", folder);
  if (source === "zotero") body.append("strip", String(Boolean(strip)));
  return xhrUpload(`${API}/import/review`, body, {
    signal,
    onProgress: (loaded, total) => onProgress?.({ phase: "upload", loaded, total }),
    onProcessing: () => onProgress?.({ phase: "processing" }),
  });
}

export function commitImport(reviewId, selected, signal) {
  return apiJson(`${API}/import/review/${encodeURIComponent(reviewId)}`, { method: "POST", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selected: [...selected] }) });
}
export function discardImport(reviewId) {
  if (reviewId) return apiJson(`${API}/import/review/${encodeURIComponent(reviewId)}`, { method: "DELETE" }).catch(() => {});
}
