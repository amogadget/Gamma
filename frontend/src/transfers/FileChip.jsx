// The file chip: a same-origin upload linked from a block —
// `[name](/api/uploads/<hash>.<ext>)`, what a dropped or pasted file becomes.
// Files are content, any type, any number per page (docs/dev/block_centric.md,
// "Files and documents"). Every chip looks the same. A PDF or markdown file
// can become a page: "Add to library" in the right-click menu — a PDF through
// `POST /blocks/by-doc/<hash>` (the page CARRIES the file: viewer,
// highlights, metadata; nothing is uploaded twice), a markdown file through
// `POST /pages/from-file` (a note page imported from it — a copy, the file
// stays). Once the page exists the chip shows an "open page" button.
//
// The chip renders inside markdown, so it is inline: it must sit in a
// sentence ("see [data.csv](…) for the raw numbers") as well as alone on a
// line.

import React, { createContext, useContext, useEffect, useReducer, useState } from "react";
import { DownloadIcon, ExternalLinkIcon, FileIcon, PaperIcon, PlusIcon } from "../shared/ui/Icons";
import { ContextMenu, MenuItem } from "../shared/ui/Menus";
import { API, apiJson, assetUrl, getCurrentWorkspace, getExpectedUser, withShare, withWorkspace } from "../shared/lib/utils";

// What the page around the chip provides: navigation and promotion come from
// App (they need the page's folder and openBlock); a chip rendered with no
// provider (the chat, an AI ghost row) is download-only.
//   { readOnly, canOpen, openPage(pageId), promoteFile(hash, ext, name) → Promise }
export const FileChipContext = createContext(null);

// --- doc id → document page lookup, batched per render -----------------------
// Every PDF / markdown chip asks "which page did this file become?"; the
// asks of one render go out as ONE request (`POST /pages/by-docs`) and the
// answers are cached until the page changes (App calls forgetDocPages on open).
const docPages = new Map();          // docId → {id, title} | null (no page)
const listeners = new Set();
let pending = new Set();
let timer = null;

function notify() {
  listeners.forEach((fn) => fn());
}

export function forgetDocPages() {
  docPages.clear();
  notify();
}

export function rememberDocPage(docId, page) {
  if (docId) docPages.set(docId, page || null);
  notify();
}

async function flushLookups() {
  timer = null;
  const ids = Array.from(pending);
  pending = new Set();
  if (!ids.length) return;
  try {
    const data = await apiJson(`${API}/pages/by-docs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc_ids: ids }),
    });
    ids.forEach((id) => docPages.set(id, data?.pages?.[id] || null));
  } catch {
    ids.forEach((id) => docPages.set(id, null));
  }
  notify();
}

function useDocPage(docId, enabled) {
  const [, rerender] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    if (!docId || !enabled) return undefined;
    listeners.add(rerender);
    if (!docPages.has(docId) && !pending.has(docId)) {
      pending.add(docId);
      if (!timer) timer = setTimeout(flushLookups, 40);
    }
    return () => listeners.delete(rerender);
  }, [docId, enabled]);
  return docId && enabled ? docPages.get(docId) : undefined;
}

// --- the markdown side ---------------------------------------------------------
const UPLOAD_RE = /^\/api\/uploads\/([0-9a-f]+)\.([a-z0-9]+)(?:[?#].*)?$/i;

// {hash, ext} of an upload URL, or null.
export function parseUploadUrl(href) {
  const m = UPLOAD_RE.exec(href || "");
  return m ? { hash: m[1], ext: m[2].toLowerCase() } : null;
}

// The chip's markdown for an upload-file reply ({url, name}).
function fileBlockMarkdown(up) {
  return `[${(up.name || "file").replace(/[\[\]]/g, "")}](${up.url})`;
}

// Where uploads report themselves: App installs {start(file) → id,
// progress(id, loaded, total), done(id, ok, detail)} so every upload made
// from a drop or paste shows in the background-tasks list and the status
// pill (with a percentage while the bytes go up). Without one (tests, the
// share view) uploads are silent.
let reporter = null;
export function setUploadReporter(r) { reporter = r; }

// Multipart POST of one file → the JSON reply, or null on refusal/failure
// (callers treat null as "nothing inserted"). XMLHttpRequest rather than
// fetch because only it reports upload progress; it bypasses the fetch
// wrapper, so the workspace header and the tab-identity guard are set by
// hand. Shared with the image upload.
export function postFile(endpoint, file) {
  const id = reporter?.start(file);
  return new Promise((resolve) => {
    let xhr;
    try {
      const form = new FormData();
      form.append("file", file);
      xhr = new XMLHttpRequest();
      xhr.open("POST", withShare(withWorkspace(endpoint)));
      xhr.withCredentials = true;
      const expected = getExpectedUser();
      if (expected) xhr.setRequestHeader("X-Gamma-User", expected);
      if (getCurrentWorkspace()) xhr.setRequestHeader("X-Gamma-Workspace", getCurrentWorkspace());
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) reporter?.progress(id, e.loaded, e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch {}
        const ok = xhr.status >= 200 && xhr.status < 300;
        reporter?.done(id, ok, ok ? "" : String(data?.detail || xhr.statusText || `HTTP ${xhr.status}`));
        resolve(ok ? data : null);
      };
      xhr.onerror = () => { reporter?.done(id, false, "network error"); resolve(null); };
      xhr.send(form);
    } catch (err) {
      reporter?.done(id, false, String(err?.message || err));
      resolve(null);
    }
  });
}

// POST /api/upload-file → {url, name} | null: any non-image file a block
// takes (drop on a row, drop on the page).
async function uploadOtherFile(file) {
  const data = file ? await postFile("/api/upload-file", file) : null;
  return data?.url ? { url: data.url, name: data.name || file.name } : null;
}

// Uploads every file and returns one markdown line per success: images
// inline (`![](url)`), everything else a file chip. Used by a drop on a block
// row and a drop on the page body.
export async function uploadFilesAsLines(files) {
  const lines = [];
  for (const file of files) {
    if (file.type?.startsWith("image/")) {
      const url = (await postFile("/api/upload-image", file))?.url;
      if (url) lines.push(`![](${url})`);
    } else {
      const up = await uploadOtherFile(file);
      if (up) lines.push(fileBlockMarkdown(up));
    }
  }
  return lines;
}

// A human word for the file's kind (the tooltip), from its extension.
const KINDS = [
  [/^pdf$/, "PDF"],
  [/^(png|jpe?g|gif|webp|svg)$/, "Image"],
  [/^(docx?|odt|rtf)$/, "Document"],
  [/^(xlsx?|ods|csv)$/, "Spreadsheet"],
  [/^(pptx?|odp|key)$/, "Slides"],
  [/^(zip|gz|tgz|tar|7z|rar|whl|dmg|deb|rpm)$/, "Archive"],
  [/^nb$/, "Mathematica notebook"],
  [/^ipynb$/, "Jupyter notebook"],
  [/^(py|m|jl|r|sh|js|ts|c|cpp|h|hpp|java|go|rs|cu)$/, "Code"],
  [/^(md|txt|tex|bib|json|ya?ml|toml|xml|log)$/, "Text"],
  [/^(h5|hdf5|mat|npy|npz|parquet|fits)$/, "Data"],
  [/^(mp4|mov|mkv|webm)$/, "Video"],
  [/^(mp3|wav|flac|ogg)$/, "Audio"],
];
function fileKindLabel(ext) {
  const e = (ext || "").toLowerCase();
  const hit = KINDS.find(([re]) => re.test(e));
  return hit ? hit[1] : e ? `${e.toUpperCase()} file` : "File";
}

const stop = (e) => e.stopPropagation();

// Every file looks the same: icon, name, a download arrow. A PDF or a
// markdown file that already has a page additionally shows a small "open
// page" button before the arrow; making that page ("Add to library") lives
// in the right-click menu, so a chip never advertises it inline.
const PAGEABLE = /^(pdf|md|markdown)$/;

export function FileChip({ href, text }) {
  const ctx = useContext(FileChipContext);
  const parsed = parseUploadUrl(href);
  const ext = parsed?.ext || "";
  const isPdf = ext === "pdf";
  const name = (text || "").trim() || decodeURIComponent((href.split("/").pop() || "file").split("?")[0]);
  const [menu, setMenu] = useState(null);
  const canOpen = !!ctx?.canOpen && PAGEABLE.test(ext);
  const page = useDocPage(parsed?.hash, canOpen);
  const url = assetUrl(href);
  const close = () => setMenu(null);
  const openPage = () => ctx.openPage(page.id);
  const makePage = () => ctx.promoteFile(parsed.hash, ext, name);

  let pageItem = null;
  if (canOpen && page) {
    pageItem = (
      <MenuItem icon={PaperIcon} title={`Open "${page.title || name}"`} onClick={() => { close(); openPage(); }}>Open page</MenuItem>
    );
  } else if (canOpen && page === null && !ctx.readOnly) {
    pageItem = (
      <MenuItem icon={PlusIcon}
        title={isPdf
          ? "Make a page for this PDF: the viewer, highlights, chat and metadata — the file is not uploaded again"
          : "Import this markdown as a note page — a copy; the file stays as it is"}
        onClick={() => { close(); makePage(); }}>Add to library</MenuItem>
    );
  }
  return (
    <span
      className="fileChip"
      title={`${fileKindLabel(ext)} — ${name}`}
      onMouseDown={stop}
      onClick={stop}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }}
    >
      <a className="fileChipMain" href={url} target="_blank" rel="noreferrer">
        <span className={`fileChipIcon fileChipIcon-${isPdf ? "pdf" : "file"}`}>
          {isPdf ? <PaperIcon size={13} strokeWidth={2} /> : <FileIcon size={13} strokeWidth={2} />}
        </span>
        <span className="linkChipText">{name}</span>
      </a>
      {canOpen && page ? (
        <button type="button" className="fileChipBtn fileChipOpen" title={`Open the page "${page.title || name}"`} aria-label="Open page"
          onClick={openPage}>
          <ExternalLinkIcon size={12} />
        </button>
      ) : null}
      <a className="fileChipBtn fileChipDownload" href={url} download={name} title="Download" aria-label="Download">
        <DownloadIcon size={12} />
      </a>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={close}>
          {pageItem}
          <MenuItem icon={DownloadIcon} onClick={() => { close(); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); }}>Download</MenuItem>
        </ContextMenu>
      ) : null}
    </span>
  );
}
