"""Import Logseq PDF-highlight exports (PDF + EDN + optional MD), annotations
embedded in the PDF itself (e.g. saved by SumatraPDF/Acrobat/Zotero), and whole
Zotero libraries (a zip of the "Zotero RDF" export)."""

import hashlib
import json
import os
import posixpath
import re
import secrets
import sqlite3
import tempfile
import zipfile

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from fractional_indexing import generate_key_between, generate_n_keys_between

from ..ai_tools import clean_path
from ..auth import require_user
from ..db import page_now, pdf_upload_path, user_db_path, user_uploads_dir
from ..server_settings import check_upload_allowed
from ..blocks_store import last_child_position
from ..logbuf import log
from ..markdown_import import md_to_blocks, split_frontmatter
from ..storage import DIGEST_CHARS, display_filename
from ..logseq_import import (
    edn_highlight_position,
    edn_highlight_to_block,
    map_color,
    md_to_ordered_blocks,
    parse_edn,
    parse_logseq_md,
)
from ..zotero_import import clean_folder_path, find_zip_entry, parse_zotero_rdf, zip_name_map

router = APIRouter(prefix="/api", tags=["import"])

_MAX_ZOTERO_MEMBERS = 20_000
_MAX_ZOTERO_RDF_BYTES = 16 * 1024 * 1024
_MAX_ZOTERO_PDF_BYTES = 2 * 1024 * 1024 * 1024
_MAX_ZOTERO_COMPRESSION_RATIO = 1_000


def _zotero_pdf_digest(zf: zipfile.ZipFile, name: str) -> tuple[str, int]:
    """Hash and validate one PDF member without loading it into memory."""
    info = zf.getinfo(name)
    if info.file_size > _MAX_ZOTERO_PDF_BYTES:
        raise ValueError("PDF archive member is too large")
    if (
        info.file_size > 10 * 1024 * 1024
        and info.file_size > max(1, info.compress_size) * _MAX_ZOTERO_COMPRESSION_RATIO
    ):
        raise ValueError("suspicious PDF compression ratio")
    digest = hashlib.sha256()
    total = 0
    first = b""
    with zf.open(info) as source:
        while chunk := source.read(1024 * 1024):
            if not first:
                first = chunk[:4]
            total += len(chunk)
            if total > _MAX_ZOTERO_PDF_BYTES:
                raise ValueError("PDF archive member is too large")
            digest.update(chunk)
    if first != b"%PDF":
        raise ValueError("not a PDF")
    return digest.hexdigest()[:DIGEST_CHARS], total


def _store_zotero_pdf(zf: zipfile.ZipFile, name: str, target) -> None:
    """Stream an already-validated member into place atomically."""
    fd, temporary = tempfile.mkstemp(suffix=".pdf", dir=str(target.parent))
    try:
        with zf.open(name) as source, os.fdopen(fd, "wb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
        os.replace(temporary, target)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


@router.post("/import/logseq")
async def import_logseq(
    request: Request,
    pdf: UploadFile = File(...),
    edn: UploadFile = File(...),
    md: UploadFile = File(None),
):
    # 1. Validate and store PDF
    user = require_user(request)
    uploads = user_uploads_dir(user)
    uploads.mkdir(parents=True, exist_ok=True)
    pdf_bytes = await pdf.read()
    if len(pdf_bytes) < 4 or pdf_bytes[:4] != b"%PDF":
        raise HTTPException(status_code=400, detail="not a valid PDF")
    digest = hashlib.sha256(pdf_bytes).hexdigest()[:DIGEST_CHARS]
    target = uploads / f"{digest}.pdf"
    if not target.exists():
        check_upload_allowed(user, len(pdf_bytes))
        target.write_bytes(pdf_bytes)
    source_url = f"/api/uploads/{digest}.pdf"

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
        edn_only = [h for h in edn_highlights if (h.get("content") or {}).get("text", "").strip() not in used_quotes]
        edn_only.sort(key=lambda h: h.get("page") or (h.get("position") or {}).get("page") or 0)
        for h in edn_only:
            import_blocks.append(edn_highlight_to_block(h))
    else:
        import_blocks = [edn_highlight_to_block(h) for h in edn_highlights]

    # 4. Get or create unified_block for this doc
    title = (pdf.filename or digest).removesuffix(".pdf")
    now = page_now()
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
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
            r[0]
            for r in conn.execute(
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
                (
                    b["id"],
                    block_id,
                    pos_key,
                    b.get("content", ""),
                    b["properties"] if isinstance(b["properties"], str) else json.dumps(b.get("properties", {})),
                    now,
                    now,
                ),
            )
            if quote:
                existing_quotes.add(quote)
            inserted += 1
        conn.execute("UPDATE unified_blocks SET updated_at=? WHERE id=?", (now, block_id))
        conn.commit()

    return {"ok": True, "block_id": block_id, "doc_id": digest, "source_url": source_url, "imported": inserted}


# --- Plain Markdown note import -----------------------------------------------

MAX_MARKDOWN_BYTES = 5 * 1024 * 1024


@router.post("/import/markdown")
async def import_markdown(request: Request, file: UploadFile = File(...),
                          folder: str = Form("")):
    """Turn one Markdown file into a note page and nested note blocks.

    Markdown is data, not an uploaded web asset: the parsed blocks are stored in
    pages.db and no original file is served back. This also makes folder and
    single-file uploads share exactly the same import path.

    Re-importing the same bytes returns the page created the first time rather
    than duplicating it — the content digest is the identity, so a folder
    upload replayed after a partial failure converges instead of piling up.
    """
    user = require_user(request)
    raw = await file.read(MAX_MARKDOWN_BYTES + 1)
    if len(raw) > MAX_MARKDOWN_BYTES:
        raise HTTPException(status_code=413, detail="Markdown file exceeds 5 MB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Markdown file must be UTF-8")

    original = display_filename(file.filename, "note.md")
    frontmatter_title, body = split_frontmatter(text)
    fallback = re.sub(r"\.(?:md|markdown)$", "", original, flags=re.I).strip() or "Untitled note"
    title = (frontmatter_title or fallback).strip()[:500]
    tree = md_to_blocks(body)
    clean_folder = clean_path(folder)
    digest = hashlib.sha256(raw).hexdigest()[:DIGEST_CHARS]
    props = {"original_filename": original, "markdown_import": digest}
    if clean_folder:
        props["folder"] = clean_folder

    now = page_now()
    page_id = secrets.token_urlsafe(9)
    imported = 0
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        # Idempotency: the same file imported twice is the same page. Serialize
        # the check with the insert so two concurrent uploads of one file can't
        # both decide they are the first.
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT id, content FROM unified_blocks WHERE parent_id = 'root' "
            "AND json_extract(properties, '$.markdown_import') = ?",
            (digest,),
        ).fetchone()
        if existing:
            conn.commit()
            return {"ok": True, "block_id": existing[0], "title": existing[1],
                    "original_filename": original, "imported": 0,
                    "folder": clean_folder, "duplicate": True}
        pos = generate_key_between(last_child_position(conn, "root"), None)
        conn.execute(
            "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
            "VALUES (?,'root',?,?,?,?,?)",
            (page_id, pos, title, json.dumps(props), now, now),
        )
        pending = [(page_id, tree)]
        while pending:
            parent_id, nodes = pending.pop()
            if not nodes:
                continue
            positions = generate_n_keys_between(None, None, n=len(nodes))
            for node, child_pos in zip(nodes, positions):
                child_id = secrets.token_urlsafe(9)
                conn.execute(
                    "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (child_id, parent_id, child_pos, node.get("content", ""), "{}", now, now),
                )
                imported += 1
                if node.get("children"):
                    pending.append((child_id, node["children"]))
        conn.commit()

    return {"ok": True, "block_id": page_id, "title": title,
            "original_filename": original, "imported": imported,
            "folder": clean_folder, "duplicate": False}


# --- Annotations embedded in the PDF file itself ------------------------------
# SumatraPDF ("save annotations"), Acrobat, Preview etc. write standard PDF
# annotation objects. Convert markup annotations to Gamma highlight blocks.

_MARKUP_TYPES = {"/Highlight", "/Underline", "/Squiggly", "/StrikeOut"}
_NOTE_TYPES = {"/Text", "/FreeText"}
# Rectangle/ellipse drawings → area highlights (position carries area: true),
# the inverse of what pdf_export.py writes for Gamma's own area notes.
_AREA_TYPES = {"/Square", "/Circle"}
_IMPORT_TYPES = _MARKUP_TYPES | _NOTE_TYPES | _AREA_TYPES


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
                # Quad rects in PDF space (origin bottom-left)
                quads = []
                qp = _resolve(obj.get("/QuadPoints"))
                rect = _resolve(obj.get("/Rect"))
                if qp:
                    nums = [float(_resolve(v)) for v in qp]
                    for i in range(0, len(nums) - 7, 8):
                        xs, ys = nums[i : i + 8 : 2], nums[i + 1 : i + 8 : 2]
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
                    picked = [
                        t
                        for (x, y, t) in chunks
                        if any(qx1 - 2 <= x <= qx2 + 2 and qy1 - 3 <= y <= qy2 + 3 for (qx1, qy1, qx2, qy2) in quads)
                    ]
                    quote = re.sub(r"\s+", " ", " ".join(picked)).strip()[:1000]
                # Flip to top-left origin (what the viewer stores)
                rects = [
                    {
                        "x1": q[0],
                        "y1": ph - q[3],
                        "x2": q[2],
                        "y2": ph - q[1],
                        "width": pw,
                        "height": ph,
                        "pageNumber": pnum,
                    }
                    for q in quads
                ]
                bounding = {
                    "x1": min(r["x1"] for r in rects),
                    "y1": min(r["y1"] for r in rects),
                    "x2": max(r["x2"] for r in rects),
                    "y2": max(r["y2"] for r in rects),
                    "width": pw,
                    "height": ph,
                    "pageNumber": pnum,
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
                        color = (
                            f"rgba({int(float(_resolve(c[0])) * 255)}, {int(float(_resolve(c[1])) * 255)}, "
                            f"{int(float(_resolve(c[2])) * 255)}, {round(alpha, 3)})"
                        )
                except Exception:
                    pass
                key = f"{pnum}:{subtype}:{round(quads[0][0])}:{round(quads[0][1])}:{round(quads[0][2])}"
                position = {"pageNumber": pnum, "boundingRect": bounding, "rects": rects}
                if subtype in _AREA_TYPES:
                    position["area"] = True
                found.append(
                    {
                        "key": key,
                        "page": pnum,
                        "content": contents,
                        "quote": quote,
                        "color": color,
                        "position": position,
                    }
                )
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


def import_embedded_annotations(user: str, block_id: str, pdf_path, strip: bool) -> dict:
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
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
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
                props = {
                    "highlight_id": bid,
                    "color": f["color"],
                    "quote": f["quote"],
                    "pdf_page": f["page"],
                    "pdf_position": f["position"],
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
            with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
                rows = conn.execute(
                    "SELECT id, properties FROM unified_blocks WHERE parent_id=? "
                    "AND json_extract(properties,'$.imported_annot') IS NOT NULL",
                    (block_id,)).fetchall()
                for bid, props_json in rows:
                    props = json.loads(props_json or "{}")
                    props["annot_stripped"] = True
                    conn.execute("UPDATE unified_blocks SET properties=? WHERE id=?", (json.dumps(props), bid))
                conn.commit()
    return {"found": len(found), "imported": inserted, "stripped": stripped}


# Sync endpoint: PyPDF2 parsing is CPU-bound; the threadpool keeps the loop free.
@router.post("/import/pdf-annotations")
def import_pdf_annotations(payload: PdfAnnotsRequest, request: Request):
    user = require_user(request)
    try:
        pdf_path = pdf_upload_path(user, payload.doc_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid document id")
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF not stored on the server")
    try:
        result = import_embedded_annotations(user, payload.block_id, pdf_path, payload.strip)
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


def _split_tags(raw: str) -> list[str]:
    """Mirror of frontend parseFolderTags: comma-separated folder/label lists."""
    return [t.strip() for t in (raw or "").split(",") if t.strip()]


def _merge_tags(existing_raw: str, new_tags: list[str]) -> str:
    merged = _split_tags(existing_raw)
    for t in new_tags:
        if t not in merged:
            merged.append(t)
    return ", ".join(merged)


def _zotero_item_page(conn, user, uploads, zf, names, base, item, prefix, now, report):
    """Store the item's PDF (if any), find-or-create its page, merge metadata,
    labels and notes. Returns (block_id, pdf_path) when embedded annotations
    should be imported afterwards, else None."""
    pdf_member = digest = None
    pdf_size = 0
    for path in item["pdf_paths"]:
        real = find_zip_entry(names, base, path)
        if not real:
            report["warnings"].append({"title": item["title"], "reason": f"file not in zip: {path}"})
            continue
        try:
            digest, pdf_size = _zotero_pdf_digest(zf, real)
        except ValueError as error:
            report["warnings"].append({"title": item["title"], "reason": f"{error}: {path}"})
            continue
        # First stored PDF becomes the page's file; extra attachments are left out.
        pdf_member = real
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
        target = pdf_upload_path(user, digest)
        if not target.exists():
            # Dedup first: limits only gate genuinely new persistent bytes.
            check_upload_allowed(user, pdf_size)
            _store_zotero_pdf(zf, pdf_member, target)
            report["pdfs_stored"] += 1
        props["doc_id"] = digest
        props["source_url"] = f"/api/uploads/{digest}.pdf"

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
        try:
            stored_pdf = pdf_upload_path(user, doc_id)
        except ValueError:
            report["warnings"].append({
                "title": item["title"],
                "reason": "invalid stored document id",
            })
        else:
            if stored_pdf.exists():
                return block_id, stored_pdf
    return None


# Sync endpoint: zip + PyPDF2 work is CPU-bound; the threadpool keeps the loop free.
@router.post("/import/zotero")
def import_zotero(request: Request, file: UploadFile = File(...),
                  strip: bool = Form(False), folder: str = Form("")):
    user = require_user(request)
    try:
        zf = zipfile.ZipFile(file.file)
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400,
                            detail="not a zip file — zip the exported folder and upload that")
    with zf:
        members = zf.infolist()
        if len(members) > _MAX_ZOTERO_MEMBERS:
            raise HTTPException(status_code=400, detail="zip contains too many entries")
        rdf_names = [entry.filename for entry in members if entry.filename.lower().endswith(".rdf")]
        if not rdf_names:
            raise HTTPException(status_code=400,
                                detail='no .rdf file in the zip — export from Zotero as "Zotero RDF" with "Export Files"')
        # The shallowest .rdf is the export manifest; z:path values resolve
        # relative to it (users zip either the folder or its contents).
        rdf_name = min(rdf_names, key=lambda n: (n.replace("\\", "/").count("/"), len(n)))
        rdf_info = zf.getinfo(rdf_name)
        if rdf_info.file_size > _MAX_ZOTERO_RDF_BYTES:
            raise HTTPException(status_code=400, detail="Zotero RDF is too large")
        base = posixpath.dirname(rdf_name.replace("\\", "/"))
        try:
            items = parse_zotero_rdf(zf.read(rdf_info).decode("utf-8"))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"could not parse the Zotero RDF: {e}")
        if not items:
            raise HTTPException(status_code=400, detail="no importable items in the export")

        names = zip_name_map(zf)
        prefix = clean_folder_path(folder)
        uploads = user_uploads_dir(user)
        uploads.mkdir(parents=True, exist_ok=True)
        now = page_now()
        report = {"items": len(items), "pages_created": 0, "pages_merged": 0,
                  "pdfs_stored": 0, "annotations_imported": 0, "notes_imported": 0,
                  "pages": [], "skipped": [], "warnings": []}
        annot_jobs = []
        with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
            for item in items:
                try:
                    job = _zotero_item_page(conn, user, uploads, zf, names, base,
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
            result = import_embedded_annotations(user, block_id, pdf_path, strip)
            report["annotations_imported"] += result["imported"]
        except Exception as e:
            log.warning(f"[zotero] annotations for {pdf_path.name} failed: {e}")
            report["warnings"].append({"title": pdf_path.name, "reason": f"annotations: {e}"})

    log.info(f"[zotero] import: {report['items']} items, "
             f"{report['pages_created']} new, {report['pages_merged']} merged, "
             f"{report['annotations_imported']} annotations, {len(report['skipped'])} skipped")
    return {"ok": True, **report}
