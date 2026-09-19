// In-place editing tools for the rendered notes: the image hover toolbar
// (drag-resize writing the Obsidian `![alt|300]` size, caption = the alt
// text, lightbox, delete)
// and the table hover controls (add/delete row & column, alignment). Every
// operation is a text transform on the block's markdown source — scanImages/
// scanTables locate the nth rendered construct so the components can address
// "their" source range without a position map from the renderer.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { scanMathSpans } from "./BlockCmEditor";
import { scanFences } from "./codeHighlight";
import { scanImageSyntax } from "./mdMarks";
import { ContextMenu, MenuItem } from "../shared/ui/Menus";
import { Segmented } from "../settings/SettingsKit";
import {
  AlignCenterIcon, AlignLeftIcon, AlignRightIcon, CaptionIcon, DownloadIcon,
  PlusIcon, Trash2Icon, ZoomInIcon,
} from "../shared/ui/Icons";

// ---------------------------------------------------------------- source scan

// Ranges an image regex must not fire inside — mirrors mdPreprocess's span
// protection (math, ``` fences, inline code) so the nth scanned image is the
// nth rendered one.
function protectedSpans(content) {
  const spans = scanMathSpans(content).map((s) => ({ from: s.from, to: s.to }));
  for (const f of scanFences(content)) spans.push({ from: f.from, to: f.to });
  for (const m of content.matchAll(/`[^`\n]+`/g)) {
    spans.push({ from: m.index, to: m.index + m[0].length });
  }
  return spans.sort((a, b) => a.from - b.from);
}
const inSpan = (spans, pos) => spans.some((s) => pos >= s.from && pos < s.to);

// The images the rendered view shows, in order. The syntax (Obsidian
// `![alt|300]` size, legacy Logseq `{:width N}` suffix) is scanImageSyntax in
// mdMarks.js, shared with the block editor's live rendering; both forms
// render, edits write the Obsidian form.
export function scanImages(content) {
  const spans = protectedSpans(content);
  return scanImageSyntax(content).filter((im) => !inSpan(spans, im.from));
}

// actions: "width" (payload px, 0 clears), "alt" (payload caption), "delete".
// Returns the new content, or null when the nth image can't be located (the
// scan and the render disagree — e.g. hand-written <img> html): no-op beats
// corrupting the wrong range.
export function applyImageEdit(content, idx, action, payload) {
  const im = scanImages(content)[idx];
  if (!im) return null;
  // Edits always write the Obsidian form (`![alt|300](url)`), so a legacy
  // `{:width N}` image is normalized the first time it's touched.
  const rebuild = (alt, width) =>
    `![${alt}${width ? `|${width}` : ""}](${im.url})`;
  if (action === "width") {
    const w = Math.round(Number(payload) || 0);
    return content.slice(0, im.from) + rebuild(im.alt, w) + content.slice(im.to);
  }
  if (action === "alt") {
    // "|" is the size separator, "[]" and newlines break the construct.
    const alt = String(payload || "").replace(/[[\]|\n]/g, " ").replace(/\s+/g, " ").trim();
    return content.slice(0, im.from) + rebuild(alt, im.width) + content.slice(im.to);
  }
  if (action === "delete") {
    let out = content.slice(0, im.from) + content.slice(im.to);
    const ls = out.lastIndexOf("\n", im.from - 1) + 1;
    let le = out.indexOf("\n", ls);
    if (le === -1) le = out.length;
    if (!out.slice(ls, le).trim()) out = out.slice(0, ls) + out.slice(Math.min(le + 1, out.length));
    return out.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
  }
  return null;
}

// GFM row → trimmed cells (outer pipes dropped, unescaped | splits — per the
// spec a | inside `code` still delimits cells unless written \|).
function splitCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}
const DELIM_CELL_RE = /^:?-+:?$/;

// Table line-groups in source order (matching remark-gfm's render order).
// Tables inside blockquotes are still counted — the nth rendered table must
// stay the nth entry — but marked editable:false (ops would have to re-prefix
// every line with ">"; not worth it).
export function scanTables(content) {
  // Only multi-line spans can hide a fake "table" (a ``` fence or $$ display
  // math with | characters on its lines); inline spans can't span rows.
  const spans = scanFences(content).concat(
    scanMathSpans(content).filter((s) => content.slice(s.from, s.to).includes("\n")),
  );
  const lines = [];
  let off = 0;
  for (const text of content.split("\n")) {
    lines.push({ text, start: off, end: off + text.length });
    off += text.length + 1;
  }
  const hidden = (l) => spans.some((s) => l.start < s.to && l.end > s.from);
  const out = [];
  for (let i = 0; i + 1 < lines.length; ) {
    const H = lines[i], D = lines[i + 1];
    const quoted = /^\s*>/.test(H.text);
    const strip = (t) => (quoted ? t.replace(/^[\s>]+/, "") : t);
    const head = strip(H.text), delim = strip(D.text);
    const ok =
      head.includes("|") && !hidden(H) && !hidden(D) &&
      /^\s*>/.test(D.text) === quoted &&
      delim.includes("-") &&
      (() => {
        const dc = splitCells(delim);
        return dc.length === splitCells(head).length && dc.every((c) => DELIM_CELL_RE.test(c));
      })();
    if (!ok) { i += 1; continue; }
    let j = i + 2;
    while (
      j < lines.length && lines[j].text.includes("|") && !hidden(lines[j]) &&
      /^\s*>/.test(lines[j].text) === quoted
    ) j += 1;
    out.push({ from: H.start, to: lines[j - 1].end, editable: !quoted });
    i = j;
  }
  return out;
}

export function parseTable(text) {
  const rows = text.split("\n").map(splitCells);
  const aligns = rows[1].map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center"
      : c.endsWith(":") ? "right"
        : c.startsWith(":") ? "left" : null);
  return { header: rows[0], aligns, body: rows.slice(2) };
}

// Pretty-printed GFM: cells padded to the column width so the source stays
// readable after every edit.
export function serializeTable({ header, aligns, body }) {
  const nCols = Math.max(header.length, 1, ...body.map((r) => r.length));
  const pad = (r) => { while (r.length < nCols) r.push(""); return r; };
  pad(header);
  body.forEach(pad);
  while (aligns.length < nCols) aligns.push(null);
  const w = Array.from({ length: nCols }, (_, c) =>
    Math.max(3, header[c].length, ...body.map((r) => r[c].length)));
  const row = (r) => `| ${r.map((t, c) => t + " ".repeat(w[c] - t.length)).join(" | ")} |`;
  const dcell = (c) => {
    const a = aligns[c];
    if (a === "center") return ":" + "-".repeat(Math.max(1, w[c] - 2)) + ":";
    if (a === "right") return "-".repeat(Math.max(1, w[c] - 1)) + ":";
    if (a === "left") return ":" + "-".repeat(Math.max(1, w[c] - 1));
    return "-".repeat(w[c]);
  };
  const delim = `| ${Array.from({ length: nCols }, (_, c) => dcell(c)).join(" | ")} |`;
  return [row(header), delim, ...body.map(row)].join("\n");
}

// ops: {type:"addRow",at} {type:"delRow",at} (at = body index),
// {type:"addCol",at} {type:"delCol",at}, {type:"align",col,dir},
// {type:"moveRow",from,to} {type:"moveCol",from,to} (body/col indices),
// {type:"setCell",row,col,text} (row 0 = header, text already \|-escaped).
export function applyTableEdit(content, idx, op) {
  const t = scanTables(content)[idx];
  if (!t || !t.editable) return null;
  const tbl = parseTable(content.slice(t.from, t.to));
  const clampAt = (at, len) => Math.max(0, Math.min(len, at));
  switch (op.type) {
    case "addRow":
      tbl.body.splice(clampAt(op.at, tbl.body.length), 0, Array(tbl.header.length).fill(""));
      break;
    case "delRow":
      if (op.at < 0 || op.at >= tbl.body.length) return null;
      tbl.body.splice(op.at, 1);
      break;
    case "addCol": {
      const at = clampAt(op.at, tbl.header.length);
      tbl.header.splice(at, 0, "");
      tbl.aligns.splice(at, 0, null);
      tbl.body.forEach((r) => { while (r.length < tbl.header.length - 1) r.push(""); r.splice(at, 0, ""); });
      break;
    }
    case "delCol": {
      if (tbl.header.length <= 1) {
        // last column: the whole table goes
        const out = content.slice(0, t.from) + content.slice(t.to);
        return out.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
      }
      if (op.at < 0 || op.at >= tbl.header.length) return null;
      tbl.header.splice(op.at, 1);
      tbl.aligns.splice(op.at, 1);
      tbl.body.forEach((r) => r.splice(op.at, 1));
      break;
    }
    case "align":
      if (op.col < 0 || op.col >= tbl.header.length) return null;
      tbl.aligns[op.col] = op.dir;
      break;
    case "moveRow": {
      const { from, to } = op;
      if (from < 0 || from >= tbl.body.length || to < 0 || to >= tbl.body.length || from === to) return null;
      const [row] = tbl.body.splice(from, 1);
      tbl.body.splice(to, 0, row);
      break;
    }
    case "moveCol": {
      const { from, to } = op;
      if (from < 0 || from >= tbl.header.length || to < 0 || to >= tbl.header.length || from === to) return null;
      const mv = (arr) => { const [x] = arr.splice(from, 1); arr.splice(to, 0, x); };
      mv(tbl.header);
      mv(tbl.aligns);
      tbl.body.forEach((r) => { while (r.length < tbl.header.length) r.push(""); mv(r); });
      break;
    }
    case "setCell": {
      const txt = String(op.text ?? "");
      if (op.col < 0 || op.col >= Math.max(tbl.header.length, 1)) return null;
      if (op.row === 0) {
        tbl.header[op.col] = txt;
      } else {
        const r = tbl.body[op.row - 1];
        if (!r) return null;
        while (r.length <= op.col) r.push("");
        r[op.col] = txt;
      }
      break;
    }
    default:
      return null;
  }
  return content.slice(0, t.from) + serializeTable(tbl) + content.slice(t.to);
}

// Pretty-print every editable table in the content (used when raw block
// editing ends, so hand-typed tables come out aligned). Returns the new
// content, or null when nothing changed. Replacements run back-to-front so
// earlier tables' offsets stay valid.
export function formatTables(content) {
  const tables = scanTables(content);
  let out = content, changed = false;
  for (let i = tables.length - 1; i >= 0; i -= 1) {
    const t = tables[i];
    if (!t.editable) continue;
    const src = content.slice(t.from, t.to);
    const pretty = serializeTable(parseTable(src));
    if (pretty !== src) {
      out = out.slice(0, t.from) + pretty + out.slice(t.to);
      changed = true;
    }
  }
  return changed ? out : null;
}

// Clipboard text/html that IS a single table (Excel / Google Sheets / our own
// rendered-table copy) → a pretty markdown table; null when the html carries
// anything beyond that one table (a rich-text paste shouldn't lose content).
export function htmlTableToMarkdown(html) {
  let doc;
  try { doc = new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
  const tables = doc.querySelectorAll("table");
  if (tables.length !== 1) return null;
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  if (norm(doc.body?.textContent) !== norm(tables[0].textContent)) return null;
  const rows = Array.from(tables[0].querySelectorAll("tr")).map((tr) =>
    Array.from(tr.children)
      .filter((c) => c.tagName === "TD" || c.tagName === "TH")
      .map((td) => norm(td.textContent).replace(/\|/g, "\\|")));
  if (rows.length < 1 || !rows[0].length) return null;
  return serializeTable({ header: rows[0], aligns: rows[0].map(() => null), body: rows.slice(1) });
}

// Tab-separated plain text (spreadsheet cells copied without an html flavor,
// CSV tools, terminals) → a pretty markdown table. Deliberately strict — ≥2
// rows, every row the same tab count, none tab-indented — so tab-indented
// code or prose with a stray tab can never be mistaken for a table.
export function tsvToMarkdown(text) {
  const lines = (text || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length < 2) return null;
  const tabs = lines.map((l) => (l.match(/\t/g) || []).length);
  if (tabs[0] < 1 || tabs.some((n) => n !== tabs[0])) return null;
  if (lines.some((l) => /^\t/.test(l))) return null;
  const rows = lines.map((l) => l.split("\t").map((c) => c.trim().replace(/\|/g, "\\|")));
  return serializeTable({ header: rows[0], aligns: rows[0].map(() => null), body: rows.slice(1) });
}

// ------------------------------------------------------------------ MdImage

// A rendered ![alt](url): click zooms (lightbox), and with onEdit a hover
// toolbar (caption / download / delete) plus a right-edge drag handle that
// writes the `|width` back into the source. The alt text doubles as a visible
// caption, Obsidian-style — no new syntax. Spans only: images live inside <p>.
export function MdImage({ src, alt, width, idx, onEdit }) {
  const [lightbox, setLightbox] = useState(false);
  const [caption, setCaption] = useState(null); // null | draft text
  const [dragW, setDragW] = useState(null);
  const imgRef = useRef(null);
  const dragRef = useRef(null); // {startX, startW, w, moved}

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => { if (e.key === "Escape") setLightbox(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const stop = (e) => e.stopPropagation();
  const w = dragW != null ? dragW : (width ? Number(width) : null);

  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    const startW = imgRef.current?.getBoundingClientRect().width || 200;
    dragRef.current = { startX: e.clientX, startW, w: null, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function moveResize(e) {
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.startX) > 2) d.moved = true;
    d.w = Math.round(Math.min(1600, Math.max(60, d.startW + (e.clientX - d.startX))));
    setDragW(d.w);
  }
  function endResize() {
    const d = dragRef.current;
    dragRef.current = null;
    setDragW(null);
    if (d?.moved && d.w) onEdit(idx, "width", d.w);
  }

  function commitCaption(text) {
    setCaption(null);
    if (text !== (alt || "")) onEdit(idx, "alt", text);
  }

  return (
    <span className="mdImgWrap">
      <span className="mdImgFrame">
        <img
          ref={imgRef}
          className="mdImg"
          src={src}
          alt={alt || ""}
          width={w || undefined}
          draggable={false}
          onMouseDown={stop}
          onClick={(e) => { e.stopPropagation(); setLightbox(true); }}
        />
        {onEdit ? (
          <span className="mdImgTools" onMouseDown={stop} onClick={stop}>
            <button type="button" className="ctlBtn" title="Zoom"
              onClick={() => setLightbox(true)}><ZoomInIcon /></button>
            <button type="button" className="ctlBtn" title={alt ? "Edit caption" : "Add caption"}
              onClick={() => setCaption(alt || "")}><CaptionIcon /></button>
            <a className="ctlBtn" title="Download" href={src} download><DownloadIcon /></a>
            <button type="button" className="ctlBtn danger" title="Remove image"
              onClick={() => onEdit(idx, "delete")}><Trash2Icon /></button>
          </span>
        ) : null}
        {onEdit ? (
          <span
            className="mdImgResize"
            title="Drag to resize · double-click for natural size"
            onMouseDown={stop}
            onClick={stop}
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onDoubleClick={(e) => { e.stopPropagation(); onEdit(idx, "width", 0); }}
          />
        ) : null}
      </span>
      {caption != null ? (
        <input
          className="mdImgCaptionInput"
          autoFocus
          value={caption}
          placeholder="Caption…"
          onChange={(e) => setCaption(e.target.value)}
          onMouseDown={stop}
          onClick={stop}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitCaption(caption);
            else if (e.key === "Escape") setCaption(null);
          }}
          onBlur={() => { if (document.hasFocus()) commitCaption(caption); }}
        />
      ) : alt ? (
        <span className="mdImgCaption">{alt}</span>
      ) : null}
      {lightbox
        ? createPortal(
          <div
            className="mdLightbox"
            onMouseDown={stop}
            onClick={(e) => { e.stopPropagation(); setLightbox(false); }}
          >
            <img src={src} alt={alt || ""} draggable={false} />
            {alt ? <div className="mdLightboxCaption">{alt}</div> : null}
          </div>,
          document.body)
        : null}
    </span>
  );
}

// --------------------------------------------------------------- MdTableWrap

// Wrapper around every rendered table: a horizontal scroller, and with onEdit
// the Notion-style controls — "+" strips on the right/bottom edges, small
// handles above the hovered column / left of the hovered row opening a menu
// (insert, align, delete), and click-a-cell in-place editing (Tab/Shift-Tab
// move between cells, Enter commits, Esc cancels; every commit re-serializes
// the table pretty-printed). Handle positions are measured from the live DOM
// at hover time, so the source mapping stays purely index-based. `model` is
// the parsed source table (cells stay raw markdown, not rendered text).
//
// A cell commit rewrites the block content, which remounts this component
// (BlockMarkdown rebuilds its element tree per render, same as the task
// checkboxes) — so a Tab-move records where to resume in this module-level
// map, keyed by block id + table index, and the mount effect reopens there.
const _tableEditSession = new Map(); // editKey → {row, col}

export function MdTableWrap({ idx, onEdit, model, editKey, children }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null); // {col,row,colX,rowY}
  const [menu, setMenu] = useState(null); // {x,y,kind,at}
  const [cellEdit, setCellEdit] = useState(null); // {row,col,text,rect}
  const [drag, setDrag] = useState(null); // drop-line: {kind, x|y, top/left, size}
  const dragRef = useRef(null); // {kind, at, from, startX, startY, moved, to}

  const stop = (e) => e.stopPropagation();
  const pick = (op) => { setMenu(null); onEdit(idx, op); };

  // Raw source text of a cell, \|-unescaped for editing.
  const cellSource = (row, col) => {
    if (!model) return "";
    const raw = row === 0 ? model.header[col] : model.body[row - 1]?.[col];
    return (raw || "").replace(/\\\|/g, "|");
  };
  const measureCell = (row, col) => {
    const wrap = wrapRef.current;
    const cell = wrap?.querySelector("table")?.rows[row]?.cells[col];
    if (!cell || !wrap) return null;
    const wr = wrap.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    return { left: cr.left - wr.left, top: cr.top - wr.top, width: cr.width, height: cr.height };
  };
  const openCell = (row, col) => {
    const rect = measureCell(row, col);
    if (!rect) return;
    _tableEditSession.set(editKey, { row, col });
    setCellEdit({ row, col, text: cellSource(row, col), rect });
  };
  const nextCell = (ce, back) => {
    const nCols = model?.header.length || 1;
    const nCells = nCols * ((model?.body.length || 0) + 1);
    const p = ce.row * nCols + ce.col + (back ? -1 : 1);
    return p < 0 || p >= nCells ? null : { row: Math.floor(p / nCols), col: p % nCols };
  };
  // Commit the open cell; `next` = cell to reopen after the rewrite (Tab).
  const commitCell = (next) => {
    const ce = cellEdit;
    if (!ce) return;
    setCellEdit(null);
    if (next) _tableEditSession.set(editKey, next);
    else _tableEditSession.delete(editKey);
    if (ce.text === cellSource(ce.row, ce.col)) {
      // no rewrite → no remount; move on directly
      if (next) openCell(next.row, next.col);
      return;
    }
    const txt = ce.text.replace(/\n/g, " ").trim().replace(/\|/g, "\\|");
    onEdit(idx, { type: "setCell", row: ce.row, col: ce.col, text: txt });
  };
  // Resume an in-progress cell-editing session after a commit remounted us.
  useEffect(() => {
    if (!onEdit || !editKey) return;
    const s = _tableEditSession.get(editKey);
    if (!s) return;
    requestAnimationFrame(() => {
      const rect = measureCell(s.row, s.col);
      if (rect) setCellEdit({ row: s.row, col: s.col, text: cellSource(s.row, s.col), rect });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The block row starts RAW editing on mousedown — intercept cell presses
  // there (this wrapper is deeper, its mousedown bubbles first) so a table
  // click edits the cell in place instead of dropping into markdown source.
  function onCellMouseDown(e) {
    if (!onEdit || !model || e.button !== 0) return;
    const cell = e.target.closest?.("td,th");
    if (!cell || !wrapRef.current?.contains(cell)) return;
    if (e.target.closest("button, input, a")) return;
    e.stopPropagation();
    e.preventDefault();
    const tr = cell.closest("tr");
    const pos = { row: tr.rowIndex, col: cell.cellIndex };
    if (cellEdit) commitCell(pos); // switch cells: commit, then reopen there
    else openCell(pos.row, pos.col);
  }
  const counts = () => {
    const table = wrapRef.current?.querySelector("table");
    return {
      nCols: table?.rows[0]?.cells.length || 1,
      nBody: Math.max(0, (table?.rows.length || 1) - 1),
    };
  };

  // Dragging a handle pill moves its column/row directly (a plain click still
  // opens the menu): track the pointer, show a drop line at the nearest
  // boundary, apply one moveCol/moveRow op on release. The op remounts this
  // component (content rewrite), which is fine — the drag is already over.
  function slotForCol(clientX) {
    const cells = [...(wrapRef.current?.querySelector("table")?.rows[0]?.cells || [])];
    let s = 0;
    for (const c of cells) {
      const r = c.getBoundingClientRect();
      if (clientX > r.left + r.width / 2) s++;
    }
    return { s, cells };
  }
  function slotForRow(clientY) {
    const rows = [...(wrapRef.current?.querySelector("table")?.rows || [])].slice(1);
    let s = 0;
    for (const r of rows) {
      const rr = r.getBoundingClientRect();
      if (clientY > rr.top + rr.height / 2) s++;
    }
    return { s, rows };
  }
  const handleDown = (kind) => (e) => {
    if (e.button !== 0 || !hover) return;
    e.preventDefault();
    e.stopPropagation();
    // preventDefault suppresses the natural blur-on-click-elsewhere; restore
    // it so a later Ctrl+Z reaches the block undo, not a stale input.
    document.activeElement?.blur?.();
    dragRef.current = {
      kind,
      at: kind === "col" ? hover.col : hover.row,
      from: kind === "col" ? hover.col : hover.row - 1,   // body index for rows
      startX: e.clientX, startY: e.clientY, moved: false, to: null,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  function handleDragMove(e) {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) <= 4) return;
    d.moved = true;
    const wrap = wrapRef.current;
    const table = wrap?.querySelector("table");
    if (!table || d.from < 0) return;                     // header row: menu only
    const wr = wrap.getBoundingClientRect();
    const tb = table.getBoundingClientRect();
    if (d.kind === "col") {
      const { s, cells } = slotForCol(e.clientX);
      if (!cells.length) return;
      d.to = Math.min(s > d.from ? s - 1 : s, cells.length - 1);
      const x = (s === 0 ? cells[0].getBoundingClientRect().left
        : cells[s - 1].getBoundingClientRect().right) - wr.left;
      setDrag({ kind: "col", x, top: tb.top - wr.top, size: tb.height });
    } else {
      const { s, rows } = slotForRow(e.clientY);
      if (!rows.length) return;
      d.to = Math.min(s > d.from ? s - 1 : s, rows.length - 1);
      const y = (s === 0 ? rows[0].getBoundingClientRect().top
        : rows[s - 1].getBoundingClientRect().bottom) - wr.top;
      setDrag({ kind: "row", y, left: tb.left - wr.left, size: tb.width });
    }
  }
  function handleUp(e) {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    if (!d.moved) {                                       // click: open the menu
      setMenu({ x: e.clientX, y: e.clientY, kind: d.kind, at: d.at });
      return;
    }
    if (d.to != null && d.from >= 0 && d.to !== d.from) {
      onEdit(idx, d.kind === "col"
        ? { type: "moveCol", from: d.from, to: d.to }
        : { type: "moveRow", from: d.from, to: d.to });
    }
  }
  const cancelDrag = () => { dragRef.current = null; setDrag(null); };

  function onOver(e) {
    if (!onEdit || dragRef.current) return;
    const cell = e.target.closest?.("td,th");
    const wrap = wrapRef.current;
    if (!cell || !wrap?.contains(cell)) return;
    const tr = cell.closest("tr");
    const wr = wrap.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    const rr = tr.getBoundingClientRect();
    setHover({
      col: cell.cellIndex,
      row: tr.rowIndex,
      colX: cr.left - wr.left + cr.width / 2,
      rowY: rr.top - wr.top + rr.height / 2,
    });
  }

  return (
    <div
      className={`mdTableWrap${onEdit ? " mdTableEditable" : ""}`}
      ref={wrapRef}
      onMouseOver={onOver}
      onMouseLeave={() => setHover(null)}
      onMouseDown={onCellMouseDown}
    >
      <div className="mdTableScroll">
        <table>{children}</table>
      </div>
      {cellEdit ? (
        <input
          className="mdTableCellInput"
          style={{
            left: cellEdit.rect.left, top: cellEdit.rect.top,
            width: cellEdit.rect.width, height: cellEdit.rect.height,
          }}
          autoFocus
          value={cellEdit.text}
          onChange={(e) => setCellEdit({ ...cellEdit, text: e.target.value })}
          onFocus={(e) => e.target.select()}
          onMouseDown={stop}
          onClick={stop}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); commitCell(null); }
            else if (e.key === "Escape") { e.preventDefault(); _tableEditSession.delete(editKey); setCellEdit(null); }
            else if (e.key === "Tab") { e.preventDefault(); commitCell(nextCell(cellEdit, e.shiftKey)); }
          }}
          // Window-level blur (Alt+Tab) keeps the cell session; the browser
          // refocuses the input when the app returns.
          onBlur={() => { if (document.hasFocus()) commitCell(null); }}
        />
      ) : null}
      {onEdit ? (
        <>
          <button type="button" className="mdTableAdd mdTableAddCol" title="Add column"
            onMouseDown={stop}
            onClick={(e) => { stop(e); onEdit(idx, { type: "addCol", at: counts().nCols }); }}>+</button>
          <button type="button" className="mdTableAdd mdTableAddRow" title="Add row"
            onMouseDown={stop}
            onClick={(e) => { stop(e); onEdit(idx, { type: "addRow", at: counts().nBody }); }}>+</button>
          {hover ? (
            <>
              <button type="button" className="mdTableHandle mdTableColHandle"
                style={{ left: hover.colX }} title="Drag to move · click for options"
                onMouseDown={stop}
                onPointerDown={handleDown("col")} onPointerMove={handleDragMove}
                onPointerUp={handleUp} onPointerCancel={cancelDrag}>⋯</button>
              <button type="button" className="mdTableHandle mdTableRowHandle"
                style={{ top: hover.rowY }}
                title={hover.row > 0 ? "Drag to move · click for options" : "Row options"}
                onMouseDown={stop}
                onPointerDown={handleDown("row")} onPointerMove={handleDragMove}
                onPointerUp={handleUp} onPointerCancel={cancelDrag}>⋮</button>
            </>
          ) : null}
          {drag?.kind === "col" ? (
            <div className="mdTableDropLine" style={{ left: drag.x - 1, top: drag.top, width: 2, height: drag.size }} />
          ) : null}
          {drag?.kind === "row" ? (
            <div className="mdTableDropLine" style={{ top: drag.y - 1, left: drag.left, height: 2, width: drag.size }} />
          ) : null}
          {menu?.kind === "col" ? (
            <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
              <div className="mdTableAlignRow" onMouseDown={stop}>
                <Segmented
                  value={model?.aligns?.[menu.at] ?? null}
                  onChange={(dir) => pick({ type: "align", col: menu.at, dir })}
                  options={[["left", "", AlignLeftIcon, "Align left"],
                    ["center", "", AlignCenterIcon, "Align center"],
                    ["right", "", AlignRightIcon, "Align right"]]}
                />
              </div>
              <MenuItem icon={PlusIcon} onClick={() => pick({ type: "addCol", at: menu.at })}>Insert left</MenuItem>
              <MenuItem icon={PlusIcon} onClick={() => pick({ type: "addCol", at: menu.at + 1 })}>Insert right</MenuItem>
              <MenuItem danger icon={Trash2Icon} onClick={() => pick({ type: "delCol", at: menu.at })}>Delete column</MenuItem>
            </ContextMenu>
          ) : null}
          {menu?.kind === "row" ? (
            <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
              {menu.at > 0 ? (
                <MenuItem icon={PlusIcon} onClick={() => pick({ type: "addRow", at: menu.at - 1 })}>Insert above</MenuItem>
              ) : null}
              <MenuItem icon={PlusIcon} onClick={() => pick({ type: "addRow", at: menu.at })}>Insert below</MenuItem>
              {menu.at > 0 ? (
                <MenuItem danger icon={Trash2Icon} onClick={() => pick({ type: "delRow", at: menu.at - 1 })}>Delete row</MenuItem>
              ) : null}
            </ContextMenu>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
