import secrets
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from pydantic import BaseModel
import aiosqlite
from pathlib import Path

app = FastAPI()
DB_PATH = Path("data.db")


class AnnotationDoc(BaseModel):
    data: str

class ShareRequest(BaseModel):
    source_url: str

class ResolvePdfRequest(BaseModel):
    source_url: str

@app.on_event("startup")
async def startup():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS annotations (
                doc_id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS shares (
                token TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL
            )
        """)
        await db.commit()


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/annotations/{doc_id}")
async def get_annotations(doc_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT data FROM annotations WHERE doc_id = ?",
            (doc_id,)
        ) as cursor:
            row = await cursor.fetchone()

    if row is None:
        return {"data": '{"version":1,"annotations":[]}'}

    return {"data": row[0]}


@app.put("/api/annotations/{doc_id}")
async def put_annotations(doc_id: str, payload: AnnotationDoc):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO annotations (doc_id, data)
            VALUES (?, ?)
            ON CONFLICT(doc_id) DO UPDATE SET data = excluded.data
        """, (doc_id, payload.data))
        await db.commit()

    return {"ok": True}

@app.post("/api/share/{doc_id}")
async def create_share(doc_id: str, payload: ShareRequest):
    token = secrets.token_urlsafe(12)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO shares (token, doc_id, source_url) VALUES (?, ?, ?)",
            (token, doc_id, payload.source_url)
        )
        await db.commit()

    return {"token": token}

@app.get("/api/share/{token}")
async def get_share(token: str):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT doc_id, source_url FROM shares WHERE token = ?",
            (token,)
        ) as cursor:
            row = await cursor.fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="share not found")

    return {"doc_id": row[0], "source_url": row[1]}

@app.post("/api/resolve-pdf")
async def resolve_pdf(payload: ResolvePdfRequest):
    try:
        req = Request(
            payload.source_url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8",
            },
        )
        with urlopen(req, timeout=20) as resp:
            final_url = resp.geturl()
            content_type = resp.headers.get("Content-Type", "").lower()

        if "application/pdf" not in content_type:
            raise HTTPException(status_code=400, detail=f"final URL is not a PDF: {content_type}")

        return {"source_url": final_url}
    except HTTPError as e:
        raise HTTPException(status_code=400, detail=f"upstream HTTP error: {e.code}")
    except URLError as e:
        raise HTTPException(status_code=400, detail=f"upstream URL error: {e.reason}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"resolve failed: {str(e)}")

@app.get("/api/pdf")
async def proxy_pdf(source_url: str):
    try:
        req = Request(
            source_url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/pdf,*/*;q=0.8",
            },
        )
        with urlopen(req, timeout=30) as resp:
            final_url = resp.geturl()
            content_type = resp.headers.get("Content-Type", "").lower()
            data = resp.read()

        if "application/pdf" not in content_type:
            raise HTTPException(status_code=400, detail=f"final URL is not a PDF: {content_type}")

        return Response(
            content=data,
            media_type="application/pdf",
            headers={
                "Cache-Control": "public, max-age=3600",
                "X-Source-Url": final_url,
            },
        )
    except HTTPError as e:
        raise HTTPException(status_code=400, detail=f"upstream HTTP error: {e.code}")
    except URLError as e:
        raise HTTPException(status_code=400, detail=f"upstream URL error: {e.reason}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"pdf proxy failed: {str(e)}")



import sqlite3
from fractional_indexing import generate_key_between, generate_n_keys_between
from datetime import datetime

# --- pages API (phase 1) ---

PAGES_DB = "/home/ubuntu/pdf-share/backend/pages.db"

class PageReorderRequest(BaseModel):
    id: str
    before: str | None = None
    after: str | None = None

class PageCreateRequest(BaseModel):
    title: str

class PageUpdateRequest(BaseModel):
    title: str
    content: str

def ensure_pages_db():
    with sqlite3.connect(PAGES_DB) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pages (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            )
            """
        )
        # Migration: add doc_id column if it doesn't exist (SQLite lacks IF NOT EXISTS for ALTER)
        cols = [row[1] for row in conn.execute("PRAGMA table_info(pages)").fetchall()]
        if "doc_id" not in cols:
            conn.execute("ALTER TABLE pages ADD COLUMN doc_id TEXT")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_doc_id ON pages(doc_id) WHERE doc_id IS NOT NULL")
        # Migration: add position (fractional index) column, backfill existing rows with sequential keys
        cols = [row[1] for row in conn.execute("PRAGMA table_info(pages)").fetchall()]
        if "position" not in cols:
            conn.execute("ALTER TABLE pages ADD COLUMN position TEXT")
            existing = conn.execute("SELECT id FROM pages ORDER BY updated_at DESC").fetchall()
            if existing:
                keys = generate_n_keys_between(None, None, n=len(existing))
                for (pid,), k in zip(existing, keys):
                    conn.execute("UPDATE pages SET position = ? WHERE id = ?", (k, pid))
            conn.execute("CREATE INDEX IF NOT EXISTS idx_pages_position ON pages(position)")

        # Blocks table (Logseq-style: one row per block, tree via parent_id + position)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS blocks (
                id TEXT PRIMARY KEY,
                page_id TEXT NOT NULL,
                parent_id TEXT,
                position INTEGER NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                properties TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_id)")
        conn.commit()

def page_now():
    return datetime.utcnow().isoformat()

ensure_pages_db()

@app.get("/api/pages")
async def list_pages():
    ensure_pages_db()
    with sqlite3.connect(PAGES_DB) as conn:
        rows = conn.execute(
            """
            SELECT p.id, p.title, p.updated_at, p.doc_id, p.position,
                   (SELECT content FROM blocks b
                    WHERE b.page_id = p.id AND b.parent_id IS NULL
                    ORDER BY b.position ASC LIMIT 1)
            FROM pages p
            ORDER BY p.position ASC, p.updated_at DESC
            """
        ).fetchall()
    out = []
    for row in rows:
        preview = (row[5] or "").strip()
        if len(preview) > 120:
            preview = preview[:120] + "..."
        out.append({
            "id": row[0],
            "title": row[1],
            "updated_at": row[2],
            "doc_id": row[3],
            "position": row[4],
            "preview": preview,
        })
    return out

@app.post("/api/pages")
async def create_page(payload: PageCreateRequest):
    ensure_pages_db()
    page_id = secrets.token_urlsafe(9)
    title = (payload.title or "").strip() or "Untitled"
    now = page_now()
    with sqlite3.connect(PAGES_DB) as conn:
        last = conn.execute(
            "SELECT position FROM pages WHERE position IS NOT NULL ORDER BY position DESC LIMIT 1"
        ).fetchone()
        last_pos = last[0] if last else None
        new_pos = generate_key_between(last_pos, None)
        conn.execute(
            "INSERT INTO pages (id, title, content, updated_at, position) VALUES (?, ?, ?, ?, ?)",
            (page_id, title, "", now, new_pos)
        )
        conn.commit()
    return {"id": page_id, "title": title, "content": "", "updated_at": now, "position": new_pos}
@app.post("/api/pages/reorder")
async def reorder_page(payload: PageReorderRequest):
    ensure_pages_db()
    try:
        new_pos = generate_key_between(payload.before, payload.after)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid before/after keys: {e}")
    with sqlite3.connect(PAGES_DB) as conn:
        cur = conn.execute("UPDATE pages SET position = ? WHERE id = ?", (new_pos, payload.id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Page not found")
        conn.commit()
    return {"id": payload.id, "position": new_pos}


@app.get("/api/pages/{page_id}")
async def get_page(page_id: str):
    ensure_pages_db()
    with sqlite3.connect(PAGES_DB) as conn:
        row = conn.execute(
            "SELECT id, title, content, updated_at FROM pages WHERE id = ?",
            (page_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="page not found")
    return {
        "id": row[0],
        "title": row[1],
        "content": row[2],
        "updated_at": row[3]
    }

@app.put("/api/pages/{page_id}")
async def update_page(page_id: str, payload: PageUpdateRequest):
    ensure_pages_db()
    now = page_now()
    with sqlite3.connect(PAGES_DB) as conn:
        cur = conn.execute(
            "UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?",
            ((payload.title or "").strip() or "Untitled", payload.content or "", now, page_id)
        )
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="page not found")
    return {"ok": True, "updated_at": now}


# --- uploads (PDF file upload with content-hash dedup) ---
import hashlib
from fastapi import UploadFile, File
from fastapi.responses import FileResponse

UPLOADS_DIR = Path("/home/ubuntu/pdf-share/uploads")
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB

@app.post("/api/uploads")
async def upload_pdf(file: UploadFile = File(...)):
    # Read file contents with size guard
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB)")
    if len(contents) < 4 or contents[:4] != b"%PDF":
        raise HTTPException(status_code=400, detail="not a valid PDF (missing %PDF header)")

    # Content-addressed: SHA-256 of bytes, take first 24 hex chars to match frontend doc_id format
    digest = hashlib.sha256(contents).hexdigest()[:24]
    target = UPLOADS_DIR / f"{digest}.pdf"

    if not target.exists():
        target.write_bytes(contents)

    return {
        "doc_id": digest,
        "source_url": f"/api/uploads/{digest}.pdf",
        "size": len(contents),
        "already_existed": target.exists() and target.stat().st_size == len(contents)
    }

@app.get("/api/uploads/{filename}")
async def serve_upload(filename: str):
    # Sanitize: only allow [hex].pdf pattern, no path traversal
    if not filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="only .pdf files served")
    stem = filename[:-4]
    if not stem or not all(c in "0123456789abcdef" for c in stem):
        raise HTTPException(status_code=400, detail="invalid filename")
    path = UPLOADS_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type="application/pdf", headers={"Cache-Control": "public, max-age=3600"})


# --- pages by doc_id (stable identity, title becomes editable) ---

@app.get("/api/pages/by-doc/{doc_id}")
async def get_page_by_doc(doc_id: str):
    ensure_pages_db()
    with sqlite3.connect(PAGES_DB) as conn:
        row = conn.execute(
            "SELECT id, title, content, updated_at FROM pages WHERE doc_id = ?",
            (doc_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="page not found for doc_id")
    return {"id": row[0], "title": row[1], "content": row[2], "updated_at": row[3]}


class PageByDocCreate(BaseModel):
    default_title: str
    legacy_title: str | None = None  # for backfill from old title-keyed pages


@app.post("/api/pages/by-doc/{doc_id}")
async def get_or_create_page_by_doc(doc_id: str, payload: PageByDocCreate):
    ensure_pages_db()
    with sqlite3.connect(PAGES_DB) as conn:
        # 1. Try doc_id lookup first
        row = conn.execute(
            "SELECT id, title, content, updated_at FROM pages WHERE doc_id = ?",
            (doc_id,)
        ).fetchone()
        if row:
            return {"id": row[0], "title": row[1], "content": row[2], "updated_at": row[3]}

        # 2. Backfill: look for legacy title-keyed page with this title, claim it
        if payload.legacy_title:
            legacy = conn.execute(
                "SELECT id, title, content, updated_at FROM pages WHERE doc_id IS NULL AND lower(title) = lower(?)",
                (payload.legacy_title.strip(),)
            ).fetchone()
            if legacy:
                conn.execute("UPDATE pages SET doc_id = ? WHERE id = ?", (doc_id, legacy[0]))
                conn.commit()
                return {"id": legacy[0], "title": legacy[1], "content": legacy[2], "updated_at": legacy[3]}

        # 3. Create new page
        page_id = secrets.token_urlsafe(9)
        title = (payload.default_title or "").strip() or "Untitled"
        now = page_now()
        conn.execute(
            "INSERT INTO pages (id, title, content, updated_at, doc_id) VALUES (?, ?, ?, ?, ?)",
            (page_id, title, "", now, doc_id)
        )
        conn.commit()
    return {"id": page_id, "title": title, "content": "", "updated_at": now}


# --- blocks API: one row per block, tree via parent_id + position ---

import json as _json

def blocks_tree_to_rows(tree, page_id, parent_id=None, now=None):
    """Flatten a nested tree of blocks (possibly with 'children') into flat rows for DB insert."""
    if now is None:
        now = page_now()
    rows = []
    for pos, node in enumerate(tree or []):
        props = node.get("properties") or {}
        if isinstance(props, str):
            try: props = _json.loads(props)
            except Exception: props = {}
        rows.append({
            "id": node["id"],
            "page_id": page_id,
            "parent_id": parent_id,
            "position": pos,
            "content": node.get("content", "") or "",
            "properties": _json.dumps(props),
            "created_at": node.get("created_at") or now,
            "updated_at": now,
        })
        children = node.get("children") or []
        if children:
            rows.extend(blocks_tree_to_rows(children, page_id, parent_id=node["id"], now=now))
    return rows

def blocks_rows_to_tree(rows):
    """Given a list of (id, parent_id, position, content, properties, created_at, updated_at) tuples,
       return a nested tree sorted by position at each level."""
    by_parent = {}
    by_id = {}
    for r in rows:
        node = {
            "id": r[0],
            "parent_id": r[1],
            "position": r[2],
            "content": r[3] or "",
            "properties": _json.loads(r[4] or "{}"),
            "created_at": r[5],
            "updated_at": r[6],
            "children": [],
        }
        by_id[node["id"]] = node
        by_parent.setdefault(r[1], []).append(node)
    for plist in by_parent.values():
        plist.sort(key=lambda n: n["position"])
    # Wire children
    for node in by_id.values():
        node["children"] = by_parent.get(node["id"], [])
    return by_parent.get(None, [])

@app.get("/api/pages/{page_id}/blocks")
async def get_blocks(page_id: str):
    ensure_pages_db()
    with sqlite3.connect(PAGES_DB) as conn:
        # Verify page exists
        if not conn.execute("SELECT 1 FROM pages WHERE id = ?", (page_id,)).fetchone():
            raise HTTPException(status_code=404, detail="page not found")
        rows = conn.execute(
            "SELECT id, parent_id, position, content, properties, created_at, updated_at FROM blocks WHERE page_id = ? ORDER BY position",
            (page_id,)
        ).fetchall()
    return {"blocks": blocks_rows_to_tree(rows)}

class BlocksPutRequest(BaseModel):
    blocks: list

@app.put("/api/pages/{page_id}/blocks")
async def put_blocks(page_id: str, payload: BlocksPutRequest):
    ensure_pages_db()
    now = page_now()
    with sqlite3.connect(PAGES_DB) as conn:
        if not conn.execute("SELECT 1 FROM pages WHERE id = ?", (page_id,)).fetchone():
            raise HTTPException(status_code=404, detail="page not found")
        rows = blocks_tree_to_rows(payload.blocks, page_id, now=now)
        conn.execute("DELETE FROM blocks WHERE page_id = ?", (page_id,))
        for r in rows:
            conn.execute(
                "INSERT INTO blocks (id, page_id, parent_id, position, content, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (r["id"], r["page_id"], r["parent_id"], r["position"], r["content"], r["properties"], r["created_at"], r["updated_at"])
            )
        # Also bump the page's updated_at so the index reflects activity
        conn.execute("UPDATE pages SET updated_at = ? WHERE id = ?", (now, page_id))
        conn.commit()
    return {"ok": True, "count": len(rows), "updated_at": now}


# --- one-time migration: annotations table -> blocks table (per page) ---
# Runs on startup. Safe to call multiple times: only migrates pages that have
# zero blocks. Reads the existing annotations JSON and seeds blocks from it.

DATA_DB = str(DB_PATH)

def migrate_annotations_to_blocks():
    ensure_pages_db()
    # Map: doc_id -> annotations_json
    annotations_by_doc = {}
    try:
        with sqlite3.connect(DATA_DB) as conn:
            for doc_id, data in conn.execute("SELECT doc_id, data FROM annotations").fetchall():
                annotations_by_doc[doc_id] = data
    except sqlite3.OperationalError:
        # annotations table doesn't exist yet (fresh install) — nothing to migrate
        return

    now = page_now()
    migrated_pages = 0
    with sqlite3.connect(PAGES_DB) as conn:
        # For each page that has a doc_id and no existing blocks, seed blocks from annotations
        pages_to_seed = conn.execute(
            """
            SELECT p.id, p.doc_id FROM pages p
            WHERE p.doc_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.page_id = p.id)
            """
        ).fetchall()

        for page_id, doc_id in pages_to_seed:
            raw = annotations_by_doc.get(doc_id)
            if not raw:
                continue
            try:
                parsed = _json.loads(raw)
            except Exception:
                continue
            ann_list = parsed.get("annotations") if isinstance(parsed, dict) else None
            if not isinstance(ann_list, list) or not ann_list:
                continue

            for pos, ann in enumerate(ann_list):
                block_id = ann.get("id") or secrets.token_urlsafe(6)
                content = (ann.get("comment") or {}).get("text") or ""
                props = {
                    "highlight_id": ann.get("id") or block_id,
                    "color": ann.get("color") or "",
                    "quote": (ann.get("content") or {}).get("text") or "",
                    "pdf_page": (ann.get("position") or {}).get("pageNumber"),
                    "pdf_position": ann.get("position") or None,
                }
                conn.execute(
                    "INSERT INTO blocks (id, page_id, parent_id, position, content, properties, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
                    (block_id, page_id, pos, content, _json.dumps(props), now, now)
                )
            migrated_pages += 1
        conn.commit()

    if migrated_pages:
        print(f"[migrate] seeded blocks for {migrated_pages} page(s) from annotations")

# Run migration at import time (after ensure_pages_db has been defined and called above)
migrate_annotations_to_blocks()
