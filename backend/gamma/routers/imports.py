"""Import Logseq PDF-highlight exports (PDF + EDN + optional MD), and
annotations embedded in the PDF itself (e.g. saved by SumatraPDF/Acrobat)."""

import hashlib
import json
import re
import secrets
import sqlite3

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from pydantic import BaseModel
from fractional_indexing import generate_key_between, generate_n_keys_between

from ..auth import require_user
from ..config import MAX_UPLOAD_BYTES
from ..db import page_now, user_db_path, user_uploads_dir
from ..blocks_store import last_child_position
from ..logseq_import import (
    edn_highlight_position,
    edn_highlight_to_block,
    map_color,
    md_to_ordered_blocks,
    parse_edn,
    parse_logseq_md,
)

router = APIRouter(prefix="/api", tags=["import"])


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
    if len(pdf_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="PDF too large")
    if len(pdf_bytes) < 4 or pdf_bytes[:4] != b"%PDF":
        raise HTTPException(status_code=400, detail="not a valid PDF")
    digest = hashlib.sha256(pdf_bytes).hexdigest()[:24]
    target = uploads / f"{digest}.pdf"
    if not target.exists():
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

    return {"ok": True, "block_id": block_id, "doc_id": digest, "source_url": source_url, "imported": inserted}


# --- Annotations embedded in the PDF file itself ------------------------------
# SumatraPDF ("save annotations"), Acrobat, Preview etc. write standard PDF
# annotation objects. Convert markup annotations to Gamma highlight blocks.

_MARKUP_TYPES = {"/Highlight", "/Underline", "/Squiggly", "/StrikeOut"}
_NOTE_TYPES = {"/Text", "/FreeText"}


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
                if subtype not in _MARKUP_TYPES | _NOTE_TYPES:
                    continue
                contents = str(_resolve(obj.get("/Contents")) or "").strip()
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
                    if c is not None and len(c) == 3:
                        color = (f"rgba({int(float(_resolve(c[0])) * 255)}, {int(float(_resolve(c[1])) * 255)}, "
                                 f"{int(float(_resolve(c[2])) * 255)}, 0.45)")
                except Exception:
                    pass
                key = f"{pnum}:{subtype}:{round(quads[0][0])}:{round(quads[0][1])}:{round(quads[0][2])}"
                found.append({
                    "key": key, "page": pnum, "content": contents, "quote": quote, "color": color,
                    "position": {"pageNumber": pnum, "boundingRect": bounding, "rects": rects},
                })
            except Exception as e:
                print(f"[pdf-annots] skipping annotation on p.{pnum}: {e}")
    return found


class PdfAnnotsRequest(BaseModel):
    block_id: str
    doc_id: str


# Sync endpoint: PyPDF2 parsing is CPU-bound; the threadpool keeps the loop free.
@router.post("/import/pdf-annotations")
def import_pdf_annotations(payload: PdfAnnotsRequest, request: Request):
    user = require_user(request)
    pdf_path = user_uploads_dir(user) / f"{payload.doc_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF not stored on the server")
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(str(pdf_path))
        found = _extract_pdf_annotations(reader)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"could not read PDF annotations: {e}")
    if not found:
        return {"ok": True, "found": 0, "imported": 0}

    now = page_now()
    inserted = 0
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id=?", (payload.block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="page block not found")
        # Idempotent: each embedded annotation carries a stable key
        existing = {r[0] for r in conn.execute(
            "SELECT json_extract(properties,'$.imported_annot') FROM unified_blocks WHERE parent_id=?",
            (payload.block_id,)).fetchall() if r[0]}
        todo = [f for f in found if f["key"] not in existing]
        if todo:
            positions = generate_n_keys_between(last_child_position(conn, payload.block_id), None, n=len(todo))
            for f, pos in zip(todo, positions):
                bid = secrets.token_urlsafe(9)
                props = {
                    "highlight_id": bid, "color": f["color"], "quote": f["quote"],
                    "pdf_page": f["page"], "pdf_position": f["position"],
                    "imported_annot": f["key"],
                }
                conn.execute(
                    "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (bid, payload.block_id, pos, f["content"], json.dumps(props), now, now),
                )
                inserted += 1
            conn.execute("UPDATE unified_blocks SET updated_at=? WHERE id=?", (now, payload.block_id))
            conn.commit()
    return {"ok": True, "found": len(found), "imported": inserted}
