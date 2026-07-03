"""Import Logseq PDF-highlight exports (PDF + EDN + optional MD)."""

import hashlib
import json
import secrets
import sqlite3

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
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
