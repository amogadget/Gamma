"""Import Logseq PDF-highlight exports (PDF + EDN + optional MD), annotations
embedded in the PDF itself (e.g. saved by SumatraPDF/Acrobat/Zotero), and whole
Zotero libraries (a zip of the "Zotero RDF" export)."""

import json
import os
import posixpath
import re
import secrets
import tempfile
import zipfile

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from fractional_indexing import generate_key_between, generate_n_keys_between

from ..auth import require_user, require_ws
from ..db import connect_pages_db, page_now, pdf_upload_path, ws_uploads_dir
from ..blocks_store import last_child_position
from ..foldertags import clean_path, parse_tags
from ..logbuf import log
from ..ops import MAX_OPS, commit_ops, note_reload
from ..markdown_import import MAX_MARKDOWN_BYTES, md_to_blocks
from ..markdown_zip_import import import_markdown_zip, markdown_page
from ..ink import InkError, dumps as ink_dumps, from_pdf_ink, parse_ink, pdf_position as ink_position
from ..storage import content_digest, display_filename, is_pdf, store_file, store_pdf
from ..logseq_import import (
    edn_highlight_position,
    edn_highlight_to_block,
    map_color,
    md_to_ordered_blocks,
    parse_edn,
    parse_logseq_md,
)
from ..zotero_import import find_zip_entry, parse_zotero_rdf, zip_name_map

router = APIRouter(prefix="/api", tags=["import"])


@router.post("/import/logseq")
async def import_logseq(
    request: Request,
    pdf: UploadFile = File(...),
    edn: UploadFile = File(...),
    md: UploadFile = File(None),
):
    # 1. Validate and store PDF
    ws = require_ws(request, write=True)
    pdf_bytes = await pdf.read()
    if not is_pdf(pdf_bytes):
        raise HTTPException(status_code=400, detail="not a valid PDF")
    digest, source_url, _ = store_pdf(ws, pdf_bytes)

    # 2. Parse EDN → build quote→highlight lookup
    edn_text = (await edn.read()).decode("utf-8")
    try:
        parsed = parse_edn(edn_text)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid EDN: {e}")
    edn_highlights = parsed.get("highlights", []) if isinstance(parsed, dict) else []

    # Build lookup by quote text for MD matching (strip whitespace for robustness)
    edn_by_quote = {}
    for h in edn_highlights:
        quote = (h.get("content") or {}).get("text", "")
        page, position = edn_highlight_position(h)
        edn_by_quote[quote.strip()] = {
            "quote": quote.strip(),
            "page": page,
            "color": map_color((h.get("properties") or {}).get("color", "yellow")),
            "position": position,
        }

    # 3. Build import blocks ordered by MD (if provided), EDN-only at end
    if md is not None:
        md_text = (await md.read()).decode("utf-8")
        md_blocks_parsed = parse_logseq_md(md_text)
        edn_by_uuid = {
            h.get("id", ""): edn_by_quote[(h.get("content") or {}).get("text", "")]
            for h in edn_highlights
            if h.get("id") and (h.get("content") or {}).get("text", "") in edn_by_quote
        }
        import_blocks, used_quotes = md_to_ordered_blocks(md_blocks_parsed, edn_by_quote, edn_by_uuid)
        # Append EDN highlights not referenced in MD, sorted by page number
        edn_only = [h for h in edn_highlights
                    if (h.get("content") or {}).get("text", "").strip() not in used_quotes]
        edn_only.sort(key=lambda h: h.get("page") or (h.get("position") or {}).get("page") or 0)
        for h in edn_only:
            import_blocks.append(edn_highlight_to_block(h))
    else:
        import_blocks = [edn_highlight_to_block(h) for h in edn_highlights]

    # 4. Get or create unified_block for this doc
    title = (pdf.filename or digest).removesuffix(".pdf")
    now = page_now()
    with connect_pages_db(ws) as conn:
        row = conn.execute(
            "SELECT id FROM unified_blocks WHERE json_extract(properties,'$.doc_id') = ?",
            (digest,),
        ).fetchone()
        if row:
            block_id = row[0]
        else:
            block_id = secrets.token_urlsafe(9)
            last_pos = last_child_position(conn, "root")
            new_pos = generate_key_between(last_pos, None)
            props = json.dumps({"doc_id": digest, "source_url": source_url})
            conn.execute(
                "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
                "VALUES (?,'root',?,?,?,?,?)",
                (block_id, new_pos, title, props, now, now),
            )

        # 5. Append blocks, skip already-imported quotes
        existing_quotes = {
            r[0] for r in conn.execute(
                "SELECT json_extract(properties,'$.quote') FROM unified_blocks WHERE parent_id=?",
                (block_id,),
            ).fetchall()
        }
        n = max(1, len(import_blocks))
        last_child_pos = last_child_position(conn, block_id)
        positions = generate_n_keys_between(last_child_pos, None, n=n)
        inserted = 0
        for b, pos_key in zip(import_blocks, positions):
            bprops = json.loads(b["properties"]) if isinstance(b["properties"], str) else b.get("properties", {})
            quote = bprops.get("quote", "")
            if quote and quote in existing_quotes:
                continue
            conn.execute(
                "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (b["id"], block_id, pos_key,
                 b.get("content", ""),
                 b["properties"] if isinstance(b["properties"], str) else json.dumps(b.get("properties", {})),
                 now, now),
            )
            if quote:
                existing_quotes.add(quote)
            inserted += 1
        conn.execute("UPDATE unified_blocks SET updated_at=? WHERE id=?", (now, block_id))
        conn.commit()
        if row and inserted:
            note_reload(ws, conn, block_id, actor)

    return {"ok": True, "block_id": block_id, "doc_id": digest, "source_url": source_url, "imported": inserted}


# --- Plain Markdown note import -----------------------------------------------

@router.post("/import/markdown")
async def import_markdown(request: Request, file: UploadFile = File(...),
                          folder: str = Form("")):
    """Turn one Markdown file into a note page and nested note blocks.

    Markdown is data, not an uploaded web asset: the parsed blocks are stored in
    pages.db and no original file is served back. This also makes folder and
    single-file uploads share exactly the same import path.
    """
    ws = require_ws(request, write=True)
    raw = await file.read(MAX_MARKDOWN_BYTES + 1)
    original = display_filename(file.filename, "note.md")
    with connect_pages_db(ws) as conn:
        result = markdown_page(conn, raw, original, folder)
    return {"ok": True, **result}


@router.post("/import/markdown-zip")
def import_markdown_zip_endpoint(request: Request, file: UploadFile = File(...),
                                 folder: str = Form("")):
    """A zip of Markdown notes → one page per .md (see markdown_zip_import):
    an Obsidian vault, Notion's Markdown & CSV export, a Gamma Markdown or
    vault export, or any zipped folder of notes. ``folder`` prefixes every
    page's folder label."""
    ws = require_ws(request, write=True)
    try:
        zf = zipfile.ZipFile(file.file)
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="not a zip file")
    with zf, connect_pages_db(ws) as conn:
        report = import_markdown_zip(ws, zf, conn, folder, page_now())
        conn.commit()
    return {"ok": True, **report}


class MarkdownBlocksRequest(BaseModel):
    text: str


@router.post("/markdown-blocks")
async def markdown_blocks(payload: MarkdownBlocksRequest, request: Request):
    """Parse markdown text into a ``{content, children}`` block tree — the
    editor's "paste as blocks" helper, same parser as the .md file import.
    Nothing is stored; the client inserts the tree through its normal
    tree-edit/autosave path."""
    require_user(request)
    if len(payload.text.encode("utf-8", errors="ignore")) > MAX_MARKDOWN_BYTES:
        raise HTTPException(status_code=413, detail="text exceeds 5 MB")
    return {"blocks": md_to_blocks(payload.text)}


# --- Annotations embedded in the PDF file itself ------------------------------
# SumatraPDF ("save annotations"), Acrobat, Preview etc. write standard PDF
# annotation objects. Convert markup annotations to Gamma highlight blocks.

_MARKUP_TYPES = {"/Highlight", "/Underline", "/Squiggly", "/StrikeOut"}
_NOTE_TYPES = {"/Text", "/FreeText"}
# Rectangle/ellipse drawings → area highlights (position carries area: true),
# the inverse of what pdf_export.py writes for Gamma's own area notes.
_AREA_TYPES = {"/Square", "/Circle"}
# Freehand drawings → handwriting groups (gamma/ink.py), the inverse of the
# /Ink annotations pdf_export.py writes.
_INK_TYPES = {"/Ink"}
_IMPORT_TYPES = _MARKUP_TYPES | _NOTE_TYPES | _AREA_TYPES | _INK_TYPES


def _ink_from_annotation(obj, pnum: int, pw: float, ph: float, contents: str):
    """One /Ink annotation → an importer record carrying the parsed ink file
    (``kind: "ink"``). A Gamma export's ``/GammaInk`` private key restores
    pressure and time; foreign ink is polylines at the annotation's width."""
    ink_list = [[float(_resolve(v)) for v in (_resolve(path) or [])]
                for path in (_resolve(obj.get("/InkList")) or [])]
    bs = _resolve(obj.get("/BS")) or {}
    try:
        width = float(_resolve(bs.get("/W", 1)))
    except (TypeError, ValueError):
        width = 1.0
    color = "#1f1f1f"
    c = _resolve(obj.get("/C"))
    try:
        if c is not None and len(c) == 3:
            color = "#%02x%02x%02x" % tuple(min(255, max(0, int(round(float(_resolve(v)) * 255)))) for v in c)
    except (TypeError, ValueError):
        pass
    try:
        alpha = min(max(float(_resolve(obj.get("/CA"))), 0.05), 1.0)
    except (TypeError, ValueError):
        alpha = 1.0
    private = _resolve(obj.get("/GammaInk"))
    try:
        ink = parse_ink(from_pdf_ink(ink_list, width, color, alpha, pnum, pw, ph,
                                     str(private) if private else None))
    except InkError as e:
        log.warning(f"[pdf-annots] skipping unreadable ink on p.{pnum}: {e}")
        return None
    if not ink.strokes:
        return None
    first = ink_list[0][:2] if ink_list and len(ink_list[0]) >= 2 else (0, 0)
    key = f"{pnum}:/Ink:{round(first[0])}:{round(first[1])}:{len(ink.strokes)}"
    return {"key": key, "page": pnum, "content": contents, "quote": "", "color": color,
            "position": ink_position(ink), "kind": "ink", "ink": ink}


def _page_text_chunks(page):
    """(x, y, text) per text chunk in PDF user space — best-effort, used to
    recover the quoted text under a markup annotation."""
    chunks = []

    def visitor(text, cm, tm, font_dict, font_size):
        if text and text.strip():
            # Translation-only composition; fine for typical body text.
            chunks.append((tm[4] + cm[4], tm[5] + cm[5], text))

    try:
        page.extract_text(visitor_text=visitor)
    except Exception:
        return []
    return chunks


def _resolve(obj):
    """PyPDF2 dict access can hand back unresolved IndirectObject references."""
    return obj.get_object() if hasattr(obj, "get_object") else obj


def _extract_pdf_annotations(reader):
    found = []
    for pnum, page in enumerate(reader.pages, start=1):
        try:
            annots = _resolve(page.get("/Annots")) or []
        except Exception:
            continue
        if not annots:
            continue
        mb = page.mediabox
        pw, ph = float(mb.width), float(mb.height)
        chunks = None  # lazily extracted once per page
        for ref in annots:
            try:
                obj = ref.get_object()
                subtype = str(obj.get("/Subtype", ""))
                if subtype not in _IMPORT_TYPES:
                    continue
                contents = str(_resolve(obj.get("/Contents")) or "").strip()
                if subtype in _INK_TYPES:
                    record = _ink_from_annotation(obj, pnum, pw, ph, contents)
                    if record:
                        found.append(record)
                    continue
                # Quad rects in PDF space (origin bottom-left)
                quads = []
                qp = _resolve(obj.get("/QuadPoints"))
                rect = _resolve(obj.get("/Rect"))
                if qp:
                    nums = [float(_resolve(v)) for v in qp]
                    for i in range(0, len(nums) - 7, 8):
                        xs, ys = nums[i:i + 8:2], nums[i + 1:i + 8:2]
                        quads.append((min(xs), min(ys), max(xs), max(ys)))
                elif rect:
                    r = [float(_resolve(v)) for v in rect]
                    quads.append((min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])))
                if not quads:
                    continue
                quote = ""
                if subtype in _MARKUP_TYPES:
                    if chunks is None:
                        chunks = _page_text_chunks(page)
                    picked = [t for (x, y, t) in chunks
                              if any(qx1 - 2 <= x <= qx2 + 2 and qy1 - 3 <= y <= qy2 + 3
                                     for (qx1, qy1, qx2, qy2) in quads)]
                    quote = re.sub(r"\s+", " ", " ".join(picked)).strip()[:1000]
                # Flip to top-left origin (what the viewer stores)
                rects = [{"x1": q[0], "y1": ph - q[3], "x2": q[2], "y2": ph - q[1],
                          "width": pw, "height": ph, "pageNumber": pnum} for q in quads]
                bounding = {
                    "x1": min(r["x1"] for r in rects), "y1": min(r["y1"] for r in rects),
                    "x2": max(r["x2"] for r in rects), "y2": max(r["y2"] for r in rects),
                    "width": pw, "height": ph, "pageNumber": pnum,
                }
                color = "rgba(255, 226, 143, 0.65)"
                c = _resolve(obj.get("/C"))
                try:
                    # /CA is the annotation's own opacity — honoring it makes a
                    # Gamma export → re-import round-trip the exact shade.
                    alpha = 0.45
                    ca = _resolve(obj.get("/CA"))
                    if ca is not None:
                        alpha = min(max(float(ca), 0.05), 1.0)
                    if c is not None and len(c) == 3:
                        color = (f"rgba({int(float(_resolve(c[0])) * 255)}, {int(float(_resolve(c[1])) * 255)}, "
                                 f"{int(float(_resolve(c[2])) * 255)}, {round(alpha, 3)})")
                except Exception:
                    pass
                key = f"{pnum}:{subtype}:{round(quads[0][0])}:{round(quads[0][1])}:{round(quads[0][2])}"
                position = {"pageNumber": pnum, "boundingRect": bounding, "rects": rects}
                if subtype in _AREA_TYPES:
                    position["area"] = True
                found.append({
                    "key": key, "page": pnum, "content": contents, "quote": quote, "color": color,
                    "position": position,
                })
            except Exception as e:
                log.warning(f"[pdf-annots] skipping annotation on p.{pnum}: {e}")
    return found


def _strip_embedded_annotations(pdf_path) -> int:
    """Rewrite the stored PDF with the annotation types we import (plus their
    /Popup companions) removed, so the viewer's canvas doesn't paint them under
    Gamma's own highlight overlays. Link annotations and anything else stay
    untouched. Returns the number of annotations removed.

    Note the file keeps its content-hash name even though its bytes change —
    the name is only a key (``doc_id`` property), never re-derived."""
    from PyPDF2 import PdfReader, PdfWriter
    from PyPDF2.generic import ArrayObject, NameObject

    strip_types = _IMPORT_TYPES | {"/Popup"}
    reader = PdfReader(str(pdf_path))
    writer = PdfWriter()
    writer.append(reader)
    removed = 0
    for page in writer.pages:
        annots = _resolve(page.get("/Annots"))
        if not annots:
            continue
        kept = ArrayObject()
        for ref in annots:
            try:
                subtype = str(_resolve(ref).get("/Subtype", ""))
            except Exception:
                subtype = ""
            if subtype in strip_types:
                removed += 1
            else:
                kept.append(ref)
        page[NameObject("/Annots")] = kept
    if not removed:
        return 0
    # Atomic swap so a concurrent download never sees a half-written file.
    fd, tmp_name = tempfile.mkstemp(suffix=".pdf", dir=str(pdf_path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            writer.write(f)
        os.replace(tmp_name, str(pdf_path))
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return removed


class PdfAnnotsRequest(BaseModel):
    block_id: str
    doc_id: str
    # Settings → "Embedded PDF annotations": strip them from the stored file
    # after importing (the alternative is hiding them viewer-side).
    strip: bool = False


def import_embedded_annotations(ws: str, block_id: str, pdf_path, strip: bool, actor: str = "") -> dict:
    """Extract the annotations embedded in the stored PDF and add the missing
    ones as highlight blocks under ``block_id`` (idempotent via the stable
    ``imported_annot`` key), then optionally strip the originals from the file.
    Shared by the per-paper endpoint below and the Zotero library import."""
    from PyPDF2 import PdfReader
    reader = PdfReader(str(pdf_path))
    found = _extract_pdf_annotations(reader)
    if not found:
        return {"found": 0, "imported": 0, "stripped": 0}

    now = page_now()
    inserted = 0
    with connect_pages_db(ws) as conn:
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id=?", (block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="page block not found")
        # Idempotent: each embedded annotation carries a stable key
        existing = {r[0] for r in conn.execute(
            "SELECT json_extract(properties,'$.imported_annot') FROM unified_blocks WHERE parent_id=?",
            (block_id,)).fetchall() if r[0]}
        todo = [f for f in found if f["key"] not in existing]
        if todo:
            positions = generate_n_keys_between(last_child_position(conn, block_id), None, n=len(todo))
            for f, pos in zip(todo, positions):
                bid = secrets.token_urlsafe(9)
                if f.get("kind") == "ink":
                    # The strokes live in an .ink upload like any drawn group.
                    filename, _ = store_file(ws, ink_dumps(f["ink"]), ".ink")
                    props = {
                        "ink_url": f"/api/uploads/{filename}", "pdf_page": f["page"],
                        "pdf_position": f["position"], "ink_strokes": len(f["ink"].strokes),
                        "color": f["color"], "imported_annot": f["key"],
                    }
                else:
                    props = {
                        "highlight_id": bid, "color": f["color"], "quote": f["quote"],
                        "pdf_page": f["page"], "pdf_position": f["position"],
                        "imported_annot": f["key"],
                    }
                conn.execute(
                    "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (bid, block_id, pos, f["content"], json.dumps(props), now, now),
                )
                inserted += 1
            conn.execute("UPDATE unified_blocks SET updated_at=? WHERE id=?", (now, block_id))
            conn.commit()
            note_reload(ws, conn, block_id, actor)

    # Strip AFTER the blocks are committed: if the rewrite fails the file is
    # untouched and the import still stands; a re-run can strip again.
    stripped = 0
    if strip:
        try:
            stripped = _strip_embedded_annotations(pdf_path)
        except Exception as e:
            log.warning(f"[pdf-annots] could not strip annotations from {pdf_path.name}: {e}")
        if stripped:
            # The embedded originals are gone from the file, so PDF export must
            # start writing these blocks again (it skips imported ones only
            # while the original annotation still lives in the PDF).
            with connect_pages_db(ws) as conn:
                ids = [r[0] for r in conn.execute(
                    "SELECT id FROM unified_blocks WHERE parent_id=? "
                    "AND json_extract(properties,'$.imported_annot') IS NOT NULL "
                    "AND json_extract(properties,'$.annot_stripped') IS NULL",
                    (block_id,)).fetchall()]
            for i in range(0, len(ids), MAX_OPS):
                commit_ops(ws, block_id, [{"op": "set", "id": bid, "props": {"annot_stripped": True}}
                                          for bid in ids[i:i + MAX_OPS]], actor=actor)
    return {"found": len(found), "imported": inserted, "stripped": stripped}


# Sync endpoint: PyPDF2 parsing is CPU-bound; the threadpool keeps the loop free.
@router.post("/import/pdf-annotations")
def import_pdf_annotations(payload: PdfAnnotsRequest, request: Request):
    ws = require_ws(request, write=True)
    try:
        pdf_path = pdf_upload_path(ws, payload.doc_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid document id")
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF not stored on the server")
    try:
        result = import_embedded_annotations(ws, payload.block_id, pdf_path, payload.strip,
                                             request.state.user or "")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"could not read PDF annotations: {e}")
    return {"ok": True, **result}


# --- Zotero library import ----------------------------------------------------
# A zip of Zotero's File → Export Library → "Zotero RDF" (with "Export Files",
# "Export Notes" and "Include Annotations"). Items become pages, collections
# folder labels, tags flat labels, item notes child blocks; reader annotations
# arrive embedded in the exported PDF copies and go through
# import_embedded_annotations above. Idempotent: pages are keyed by the file
# hash and by properties.zotero_key (export bytes change between exports —
# Zotero re-embeds annotations — so the item key is what survives a re-export).


def _merge_tags(existing_raw: str, new_tags: list[str]) -> str:
    merged = parse_tags(existing_raw)
    for t in new_tags:
        if t not in merged:
            merged.append(t)
    return ", ".join(merged)


def _zotero_item_page(conn, ws, uploads, zf, names, base, item, prefix, now, report):
    """Store the item's PDF (if any), find-or-create its page, merge metadata,
    labels and notes. Returns (block_id, pdf_path) when embedded annotations
    should be imported afterwards, else None."""
    pdf_bytes = digest = None
    for path in item["pdf_paths"]:
        real = find_zip_entry(names, base, path)
        if not real:
            report["warnings"].append({"title": item["title"], "reason": f"file not in zip: {path}"})
            continue
        data = zf.read(real)
        if not is_pdf(data):
            report["warnings"].append({"title": item["title"], "reason": f"not a PDF: {path}"})
            continue
        # First stored PDF becomes the page's file; extra attachments are left out.
        pdf_bytes, digest = data, content_digest(data)
        if len(item["pdf_paths"]) > 1:
            report["warnings"].append({"title": item["title"],
                                       "reason": f"only the first of {len(item['pdf_paths'])} PDFs imported"})
        break

    # Find the page: by file hash first, then by the Zotero item key (a
    # re-export produces different bytes, so the key is the durable identity).
    row = None
    if digest:
        row = conn.execute(
            "SELECT id, properties FROM unified_blocks WHERE parent_id='root' "
            "AND json_extract(properties,'$.doc_id') = ?", (digest,)).fetchone()
    if row is None and item["key"]:
        row = conn.execute(
            "SELECT id, properties FROM unified_blocks WHERE parent_id='root' "
            "AND json_extract(properties,'$.zotero_key') = ?", (item["key"],)).fetchone()

    created = row is None
    if created:
        block_id, props = secrets.token_urlsafe(9), {}
    else:
        block_id, props = row[0], json.loads(row[1] or "{}")

    # Attach the file only when the page doesn't already have one — a page
    # found by zotero_key keeps its existing PDF (and the highlights tied to it).
    if digest and not props.get("doc_id"):
        _, source_url, already_existed = store_pdf(ws, pdf_bytes)
        if not already_existed:
            report["pdfs_stored"] += 1
        props["doc_id"] = digest
        props["source_url"] = source_url

    if item["meta"]["title"] and not props.get("meta"):
        props["meta"] = item["meta"]
        if not props.get("bibtex"):
            from .metadata import _build_bibtex
            props["bibtex"] = _build_bibtex(item["meta"])
    props["zotero_key"] = item["key"]

    folders = [f"{prefix}/{p}" if prefix else p for p in item["folders"]]
    if prefix and not folders:
        folders = [prefix]
    if folders:
        props["folder"] = _merge_tags(props.get("folder"), folders)
    if item["tags"]:
        props["category"] = _merge_tags(props.get("category"), item["tags"])

    if created:
        pos = generate_key_between(last_child_position(conn, "root"), None)
        conn.execute(
            "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
            "VALUES (?,'root',?,?,?,?,?)",
            (block_id, pos, item["title"], json.dumps(props), now, now))
        report["pages_created"] += 1
    else:
        conn.execute("UPDATE unified_blocks SET properties=?, updated_at=? WHERE id=?",
                     (json.dumps(props), now, block_id))
        report["pages_merged"] += 1
    report["pages"].append({"id": block_id, "title": item["title"], "created": created})

    if item["notes"]:
        existing = {r[0] for r in conn.execute(
            "SELECT json_extract(properties,'$.zotero_note') FROM unified_blocks WHERE parent_id=?",
            (block_id,)).fetchall() if r[0]}
        todo = [n for n in item["notes"] if n["key"] not in existing]
        if todo:
            positions = generate_n_keys_between(last_child_position(conn, block_id), None, n=len(todo))
            for note, pos in zip(todo, positions):
                conn.execute(
                    "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (secrets.token_urlsafe(9), block_id, pos, note["text"],
                     json.dumps({"zotero_note": note["key"]}), now, now))
                report["notes_imported"] += 1

    doc_id = props.get("doc_id")
    if doc_id:
        pdf_path = uploads / f"{doc_id}.pdf"
        if pdf_path.exists():
            return block_id, pdf_path
    return None


# Sync endpoint: zip + PyPDF2 work is CPU-bound; the threadpool keeps the loop free.
@router.post("/import/zotero")
def import_zotero(request: Request, file: UploadFile = File(...),
                  strip: bool = Form(False), folder: str = Form("")):
    ws = require_ws(request, write=True)
    try:
        zf = zipfile.ZipFile(file.file)
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400,
                            detail="not a zip file — zip the exported folder and upload that")
    with zf:
        rdf_names = [n for n in zf.namelist() if n.lower().endswith(".rdf")]
        if not rdf_names:
            raise HTTPException(status_code=400,
                                detail='no .rdf file in the zip — export from Zotero as "Zotero RDF" with "Export Files"')
        # The shallowest .rdf is the export manifest; z:path values resolve
        # relative to it (users zip either the folder or its contents).
        rdf_name = min(rdf_names, key=lambda n: (n.replace("\\", "/").count("/"), len(n)))
        base = posixpath.dirname(rdf_name.replace("\\", "/"))
        try:
            items = parse_zotero_rdf(zf.read(rdf_name).decode("utf-8"))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"could not parse the Zotero RDF: {e}")
        if not items:
            raise HTTPException(status_code=400, detail="no importable items in the export")

        names = zip_name_map(zf)
        prefix = clean_path(folder)
        uploads = ws_uploads_dir(ws)
        uploads.mkdir(parents=True, exist_ok=True)
        now = page_now()
        report = {"items": len(items), "pages_created": 0, "pages_merged": 0,
                  "pdfs_stored": 0, "annotations_imported": 0, "notes_imported": 0,
                  "pages": [], "skipped": [], "warnings": []}
        annot_jobs = []
        with connect_pages_db(ws) as conn:
            for item in items:
                try:
                    job = _zotero_item_page(conn, ws, uploads, zf, names, base,
                                            item, prefix, now, report)
                    if job:
                        annot_jobs.append(job)
                except HTTPException as e:  # per-file quota (413/507) skips the item
                    report["skipped"].append({"title": item["title"], "reason": str(e.detail)})
                except Exception as e:
                    log.warning(f"[zotero] item '{item['title'][:80]}' failed: {e}")
                    report["skipped"].append({"title": item["title"], "reason": str(e)})
            conn.commit()

    # Annotations after the page transaction is committed and closed —
    # import_embedded_annotations opens its own connections.
    for block_id, pdf_path in annot_jobs:
        try:
            result = import_embedded_annotations(ws, block_id, pdf_path, strip, request.state.user or "")
            report["annotations_imported"] += result["imported"]
        except Exception as e:
            log.warning(f"[zotero] annotations for {pdf_path.name} failed: {e}")
            report["warnings"].append({"title": pdf_path.name, "reason": f"annotations: {e}"})

    log.info(f"[zotero] import: {report['items']} items, "
             f"{report['pages_created']} new, {report['pages_merged']} merged, "
             f"{report['annotations_imported']} annotations, {len(report['skipped'])} skipped")
    return {"ok": True, **report}
