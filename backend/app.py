import secrets
import json
import re
import random
import string
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
    title: str | None = None
    before: str | None = None
    after: str | None = None

class PageUpdateRequest(BaseModel):
    summary: str | None = None
    title: str | None = None
    content: str | None = None

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
        # Migration: add summary column for a per-page, user-editable short description
        cols = [row[1] for row in conn.execute("PRAGMA table_info(pages)").fetchall()]
        if "summary" not in cols:
            conn.execute("ALTER TABLE pages ADD COLUMN summary TEXT")
        # Migration: add source_url for one-click page-to-PDF open
        cols = [row[1] for row in conn.execute("PRAGMA table_info(pages)").fetchall()]
        if "source_url" not in cols:
            conn.execute("ALTER TABLE pages ADD COLUMN source_url TEXT")
            # Backfill: uploaded PDFs are content-hashed, we can reconstruct their URL
            rows = conn.execute("SELECT id, doc_id FROM pages WHERE doc_id IS NOT NULL").fetchall()
            for pid, did in rows:
                upload_path = UPLOAD_DIR / f"{did}.pdf"
                if upload_path.exists():
                    conn.execute("UPDATE pages SET source_url = ? WHERE id = ?", (f"/api/uploads/{did}.pdf", pid))

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

        # Unified block tree — everything is a block
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS unified_blocks (
                id         TEXT PRIMARY KEY,
                parent_id  TEXT REFERENCES unified_blocks(id),
                position   TEXT NOT NULL,
                content    TEXT NOT NULL DEFAULT '',
                properties TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ub_parent ON unified_blocks(parent_id, position)"
        )
        conn.commit()

def page_now():
    # Emit UTC ISO string with Z suffix so clients parse it correctly.
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"

ensure_pages_db()

@app.get("/api/pages")
async def list_pages():
    ensure_pages_db()
    with sqlite3.connect(PAGES_DB) as conn:
        rows = conn.execute(
            """
            SELECT p.id, p.title, p.updated_at, p.doc_id, p.position, p.source_url, p.summary,
                   (SELECT content FROM blocks b
                    WHERE b.page_id = p.id AND b.parent_id IS NULL
                    ORDER BY b.position ASC LIMIT 1)
            FROM pages p
            ORDER BY p.position ASC, p.updated_at DESC
            """
        ).fetchall()
    out = []
    for row in rows:
        preview = (row[7] or "").strip()
        if len(preview) > 120:
            preview = preview[:120] + "..."
        out.append({
            "id": row[0],
            "title": row[1],
            "updated_at": row[2],
            "doc_id": row[3],
            "position": row[4],
            "source_url": row[5],
            "summary": row[6] or "",
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
        if payload.before is not None or payload.after is not None:
            try:
                new_pos = generate_key_between(payload.before, payload.after)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid before/after keys: {e}")
        else:
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
            "SELECT id, title, content, updated_at, doc_id, source_url, summary FROM pages WHERE id = ?",
            (page_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="page not found")
    return {
        "id": row[0],
        "title": row[1],
        "content": row[2],
        "updated_at": row[3],
        "doc_id": row[4],
        "source_url": row[5],
        "summary": row[6] or "",
    }

@app.put("/api/pages/{page_id}")
async def update_page(page_id: str, payload: PageUpdateRequest):
    ensure_pages_db()
    now = page_now()
    with sqlite3.connect(PAGES_DB) as conn:
        # Only update fields the client explicitly sent. updated_at always bumps.
        sets = ["updated_at = ?"]
        values = [now]
        if payload.title is not None:
            sets.append("title = ?")
            values.append((payload.title or "").strip() or "Untitled")
        if payload.content is not None:
            sets.append("content = ?")
            values.append(payload.content)
        if payload.summary is not None:
            sets.append("summary = ?")
            values.append(payload.summary)
        values.append(page_id)
        cur = conn.execute(
            f"UPDATE pages SET {', '.join(sets)} WHERE id = ?",
            values,
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

@app.delete("/api/pages/{page_id}")
async def delete_page(page_id: str):
    ensure_pages_db()
    with sqlite3.connect(PAGES_DB) as conn:
        # Delete blocks first, then the page
        conn.execute("DELETE FROM blocks WHERE page_id = ?", (page_id,))
        cur = conn.execute("DELETE FROM pages WHERE id = ?", (page_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="page not found")
    return {"ok": True, "id": page_id}


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
    source_url: str | None = None


@app.post("/api/pages/by-doc/{doc_id}")
async def get_or_create_page_by_doc(doc_id: str, payload: PageByDocCreate):
    ensure_pages_db()
    with sqlite3.connect(PAGES_DB) as conn:
        # 1. Try doc_id lookup first
        row = conn.execute(
            "SELECT id, title, content, updated_at, source_url FROM pages WHERE doc_id = ?",
            (doc_id,)
        ).fetchone()
        if row:
            # Opportunistic: backfill source_url if missing and client provided one
            if (not row[4]) and payload.source_url:
                conn.execute("UPDATE pages SET source_url = ? WHERE id = ?", (payload.source_url, row[0]))
                conn.commit()
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
            "INSERT INTO pages (id, title, content, updated_at, doc_id, source_url) VALUES (?, ?, ?, ?, ?, ?)",
            (page_id, title, "", now, doc_id, payload.source_url)
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


@app.get("/api/block-search")
async def block_search(q: str = "", ids: str = "", limit: int = 10):
    ensure_pages_db()
    with sqlite3.connect(PAGES_DB) as conn:
        if ids:
            id_list = [i.strip() for i in ids.split(",") if i.strip()]
            if not id_list:
                return {"blocks": []}
            placeholders = ",".join("?" * len(id_list))
            rows = conn.execute(
                f"SELECT b.id, b.content, b.page_id, p.title FROM blocks b JOIN pages p ON b.page_id = p.id WHERE b.id IN ({placeholders})",
                id_list,
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT b.id, b.content, b.page_id, p.title
                FROM blocks b JOIN pages p ON b.page_id = p.id
                WHERE b.content LIKE ? AND b.content != ''
                ORDER BY b.updated_at DESC
                LIMIT ?
                """,
                (f"%{q}%", limit),
            ).fetchall()
    return {"blocks": [{"id": r[0], "content": r[1], "page_id": r[2], "page_title": r[3]} for r in rows]}


# --- Logseq EDN import ---

def _parse_edn(text):
    """Minimal EDN parser covering Logseq's highlight export format."""
    pos = [0]

    def skip():
        while pos[0] < len(text):
            c = text[pos[0]]
            if c in ' \t\n\r,':
                pos[0] += 1
            elif c == ';':  # line comment
                while pos[0] < len(text) and text[pos[0]] != '\n':
                    pos[0] += 1
            else:
                break

    def val():
        skip()
        if pos[0] >= len(text):
            raise ValueError("unexpected end")
        c = text[pos[0]]
        if c == '{':
            return parse_map()
        if c in '([':
            close = ')' if c == '(' else ']'
            pos[0] += 1
            items = []
            while True:
                skip()
                if text[pos[0]] == close:
                    pos[0] += 1
                    return items
                items.append(val())
        if c == '"':
            return parse_str()
        if c == ':':
            return parse_kw()
        if c == '#':
            pos[0] += 1
            tag = parse_sym()
            skip()
            v = val()
            return v  # discard tag (e.g. #uuid → just the string)
        if c == '-' or c.isdigit():
            return parse_num()
        sym = parse_sym()
        if sym == 'true': return True
        if sym == 'false': return False
        if sym == 'nil': return None
        return sym

    def parse_map():
        pos[0] += 1  # '{'
        d = {}
        while True:
            skip()
            if text[pos[0]] == '}':
                pos[0] += 1
                return d
            k = val()
            v = val()
            d[k] = v

    def parse_str():
        pos[0] += 1  # '"'
        buf = []
        while pos[0] < len(text):
            c = text[pos[0]]
            if c == '"':
                pos[0] += 1
                return ''.join(buf)
            if c == '\\':
                pos[0] += 1
                esc = text[pos[0]]
                buf.append({'n':'\n','t':'\t','r':'\r','"':'"','\\':'\\','/':'/'}.get(esc, esc))
            else:
                buf.append(c)
            pos[0] += 1
        raise ValueError("unterminated string")

    def parse_kw():
        pos[0] += 1  # ':'
        return parse_sym()

    def parse_sym():
        start = pos[0]
        while pos[0] < len(text) and text[pos[0]] not in ' \t\n\r,{}()[]"':
            pos[0] += 1
        return text[start:pos[0]]

    def parse_num():
        start = pos[0]
        if text[pos[0]] == '-':
            pos[0] += 1
        while pos[0] < len(text) and (text[pos[0]].isdigit() or text[pos[0]] == '.'):
            pos[0] += 1
        s = text[start:pos[0]]
        return float(s) if '.' in s else int(s)

    return val()


def _make_block_id():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))


# Logseq named colors → app rgba colors (closest match)
_LOGSEQ_COLORS = {
    'yellow': 'rgba(255, 226, 143, 0.65)',
    'orange': 'rgba(255, 226, 143, 0.65)',
    'red':    'rgba(255, 226, 143, 0.65)',
    'green':  'rgba(170, 235, 170, 0.65)',
    'blue':   'rgba(155, 205, 255, 0.65)',
    'purple': 'rgba(230, 180, 255, 0.65)',
    'pink':   'rgba(230, 180, 255, 0.65)',
}

def _map_color(c):
    """Map a Logseq color name to the app's closest rgba color."""
    return _LOGSEQ_COLORS.get(str(c).lower().strip(), 'rgba(255, 226, 143, 0.65)')


def _parse_logseq_md(text):
    """Parse a Logseq PDF-highlights .md file into a block tree."""
    lines = text.split('\n')

    def count_tabs(line):
        n = 0
        while n < len(line) and line[n] == '\t':
            n += 1
        return n

    root = {'content': '', 'indent': -1, 'properties': {}, 'children': []}
    stack = [root]
    i = 0
    # skip front-matter (lines before first bare `-` or tab-indented block)
    while i < len(lines):
        l = lines[i].rstrip()
        if re.match(r'^\t*- ?', l):
            break
        i += 1

    while i < len(lines):
        line = lines[i].rstrip()
        tabs = count_tabs(line)
        rest = line[tabs:]

        if rest == '-' or rest.startswith('- '):
            content = rest[2:].strip() if rest.startswith('- ') else ''
            props = {}
            j = i + 1
            # consume property continuation lines (same tab depth + 2 spaces)
            prop_prefix = '\t' * tabs + '  '
            while j < len(lines):
                pl = lines[j].rstrip()
                if pl.startswith(prop_prefix) and not pl[len(prop_prefix):].startswith('- '):
                    prop_body = pl[len(prop_prefix):]
                    if ':: ' in prop_body:
                        k, v = prop_body.split(':: ', 1)
                        props[k.strip()] = v.strip()
                    j += 1
                else:
                    break
            i = j
            block = {'content': content, 'indent': tabs, 'properties': props, 'children': []}
            while len(stack) > 1 and stack[-1]['indent'] >= tabs:
                stack.pop()
            stack[-1]['children'].append(block)
            stack.append(block)
        else:
            i += 1

    return root['children']


def _collect_notes(block):
    """Return note text from direct non-annotation children."""
    return [c['content'] for c in block.get('children', [])
            if c['properties'].get('ls-type') != 'annotation' and c['content']]


def _md_to_ordered_blocks(md_blocks, edn_by_quote, edn_by_uuid):
    """
    Walk the MD tree in document order and produce import blocks.
    Matched annotations → highlight blocks (EDN position data).
    Unmatched annotations / plain blocks → plain note blocks.
    Returns (ordered_blocks, used_edn_quotes).
    """
    ordered = []
    used_quotes = set()

    def make_highlight(edn, notes, color_name):
        bid = _make_block_id()
        pos = edn['position']
        page = edn['page']
        color = _map_color(color_name or edn.get('color', 'yellow'))
        ordered.append({
            'id': bid,
            'content': notes,
            'properties': json.dumps({
                'highlight_id': bid,
                'color': color,
                'quote': edn['quote'],
                'pdf_page': page,
                'pdf_position': pos,
            }),
        })
        used_quotes.add(edn['quote'])

    def make_note(content):
        if content:
            ordered.append({'id': _make_block_id(), 'content': content, 'properties': json.dumps({})})

    def process(block):
        props = block['properties']
        content = block['content'].strip()
        is_annotation = props.get('ls-type') == 'annotation'

        if is_annotation and content:
            notes = '\n'.join(_collect_notes(block)).strip()
            uid = props.get('id', '')
            edn = edn_by_uuid.get(uid) or edn_by_quote.get(content.strip())
            if edn:
                make_highlight(edn, notes, props.get('hl-color'))
            else:
                # Still a real highlight — just no bounding box in this EDN snapshot
                page = props.get('hl-page', '')
                color = _map_color(props.get('hl-color', 'yellow'))
                bid = _make_block_id()
                ordered.append({
                    'id': bid,
                    'content': notes,
                    'properties': json.dumps({
                        'highlight_id': bid,
                        'color': color,
                        'quote': content,
                        'pdf_page': int(page) if page else None,
                        'pdf_position': None,
                    }),
                })
            # Recurse only into annotation children
            for child in block.get('children', []):
                if child['properties'].get('ls-type') == 'annotation':
                    process(child)
        elif content and not is_annotation and not content.startswith('#') and content not in ('-', ''):
            make_note(content)
            for child in block.get('children', []):
                process(child)
        else:
            for child in block.get('children', []):
                process(child)

    for block in md_blocks:
        process(block)
    return ordered, used_quotes


def _edn_highlight_to_block(h, index):
    bid = _make_block_id()
    pos_edn = h.get('position', {})
    page = h.get('page') or pos_edn.get('page') or 1
    bounding = pos_edn.get('bounding', {})
    rects = pos_edn.get('rects', [])

    def add_page(r):
        return {**{k: v for k, v in r.items()}, 'pageNumber': page}

    pdf_position = {
        'pageNumber': page,
        'boundingRect': add_page(bounding),
        'rects': [add_page(r) for r in rects],
    }

    props = h.get('properties', {})
    color = _map_color(props.get('color', 'yellow'))
    quote = (h.get('content') or {}).get('text', '')

    return {
        'id': bid,
        'parent_id': None,
        'position': index,
        'content': '',
        'properties': json.dumps({
            'highlight_id': bid,
            'color': color,
            'quote': quote,
            'pdf_page': page,
            'pdf_position': pdf_position,
        }),
    }


@app.post("/api/import/logseq")
async def import_logseq(
    pdf: UploadFile = File(...),
    edn: UploadFile = File(...),
    md: UploadFile = File(None),
):
    # 1. Validate and store PDF
    pdf_bytes = await pdf.read()
    if len(pdf_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="PDF too large")
    if len(pdf_bytes) < 4 or pdf_bytes[:4] != b"%PDF":
        raise HTTPException(status_code=400, detail="not a valid PDF")
    digest = hashlib.sha256(pdf_bytes).hexdigest()[:24]
    target = UPLOADS_DIR / f"{digest}.pdf"
    if not target.exists():
        target.write_bytes(pdf_bytes)
    source_url = f"/api/uploads/{digest}.pdf"

    # 2. Parse EDN → build quote→highlight lookup
    edn_text = (await edn.read()).decode('utf-8')
    try:
        parsed = _parse_edn(edn_text)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid EDN: {e}")
    edn_highlights = parsed.get('highlights', []) if isinstance(parsed, dict) else []

    # Build lookup by quote text for MD matching (strip whitespace for robustness)
    edn_by_quote = {}
    for h in edn_highlights:
        quote = (h.get('content') or {}).get('text', '')
        pos_edn = h.get('position', {})
        page = h.get('page') or pos_edn.get('page') or 1
        bounding = pos_edn.get('bounding', {})
        rects = pos_edn.get('rects', [])
        def add_page(r, pg=page):
            return {**{k: v for k, v in r.items()}, 'pageNumber': pg}
        edn_by_quote[quote.strip()] = {
            'quote': quote.strip(),
            'page': page,
            'color': (h.get('properties') or {}).get('color', 'yellow'),
            'position': {
                'pageNumber': page,
                'boundingRect': add_page(bounding),
                'rects': [add_page(r) for r in rects],
            },
        }

    # 3. Build import blocks ordered by MD (if provided), EDN-only at end
    if md is not None:
        md_text = (await md.read()).decode('utf-8')
        md_blocks_parsed = _parse_logseq_md(md_text)
        edn_by_uuid = {
            h.get('id', ''): edn_by_quote[(h.get('content') or {}).get('text', '')]
            for h in edn_highlights
            if h.get('id') and (h.get('content') or {}).get('text', '') in edn_by_quote
        }
        import_blocks, used_quotes = _md_to_ordered_blocks(md_blocks_parsed, edn_by_quote, edn_by_uuid)
        # Append EDN highlights not referenced in MD, sorted by page number
        edn_only = [h for h in edn_highlights
                    if (h.get('content') or {}).get('text', '').strip() not in used_quotes]
        edn_only.sort(key=lambda h: h.get('page') or (h.get('position') or {}).get('page') or 0)
        for h in edn_only:
            import_blocks.append(_edn_highlight_to_block(h, 0))
    else:
        import_blocks = [_edn_highlight_to_block(h, 0) for h in edn_highlights]

    # 4. Get or create unified_block for this doc
    title = (pdf.filename or digest).removesuffix('.pdf')
    now = page_now()
    ensure_pages_db()
    with sqlite3.connect(PAGES_DB) as conn:
        row = conn.execute(
            "SELECT id FROM unified_blocks WHERE json_extract(properties,'$.doc_id') = ?",
            (digest,),
        ).fetchone()
        if row:
            block_id = row[0]
        else:
            block_id = secrets.token_urlsafe(9)
            last_pos = ub_last_child_position(conn, "root")
            new_pos = generate_key_between(last_pos, None)
            props = _json.dumps({"doc_id": digest, "source_url": source_url})
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
        last_child_pos = ub_last_child_position(conn, block_id)
        positions = generate_n_keys_between(last_child_pos, None, n=n)
        inserted = 0
        for b, pos_key in zip(import_blocks, positions):
            bprops = json.loads(b['properties']) if isinstance(b['properties'], str) else b.get('properties', {})
            quote = bprops.get('quote', '')
            if quote and quote in existing_quotes:
                continue
            conn.execute(
                "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (b['id'], block_id, pos_key,
                 b.get('content', ''),
                 b['properties'] if isinstance(b['properties'], str) else json.dumps(b.get('properties', {})),
                 now, now),
            )
            if quote:
                existing_quotes.add(quote)
            inserted += 1
        conn.execute("UPDATE unified_blocks SET updated_at=? WHERE id=?", (now, block_id))
        conn.commit()

    return {"ok": True, "block_id": block_id, "doc_id": digest, "source_url": source_url, "imported": inserted}


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


# ---------------------------------------------------------------------------
# Unified blocks API  (/api/blocks/*)
# ---------------------------------------------------------------------------

def ub_rows_to_tree(rows):
    """Convert flat (id, parent_id, position, content, properties, created_at, updated_at)
    rows from unified_blocks into a nested tree sorted by position at each level."""
    by_parent: dict = {}
    by_id: dict = {}
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
    for node in by_id.values():
        node["children"] = by_parent.get(node["id"], [])
    return by_parent.get(None, [])

def ub_fetch_subtree(conn, block_id: str):
    """Fetch a block + all its descendants from unified_blocks."""
    rows = conn.execute(
        """
        WITH RECURSIVE subtree AS (
            SELECT id, parent_id, position, content, properties, created_at, updated_at
            FROM unified_blocks WHERE id = ?
            UNION ALL
            SELECT ub.id, ub.parent_id, ub.position, ub.content, ub.properties, ub.created_at, ub.updated_at
            FROM unified_blocks ub JOIN subtree s ON ub.parent_id = s.id
        )
        SELECT id, parent_id, position, content, properties, created_at, updated_at FROM subtree
        """,
        (block_id,),
    ).fetchall()
    return rows

def ub_delete_subtree(conn, block_id: str):
    """Delete a block and all its descendants."""
    conn.execute(
        """
        WITH RECURSIVE subtree AS (
            SELECT id FROM unified_blocks WHERE id = ?
            UNION ALL
            SELECT ub.id FROM unified_blocks ub JOIN subtree s ON ub.parent_id = s.id
        )
        DELETE FROM unified_blocks WHERE id IN (SELECT id FROM subtree)
        """,
        (block_id,),
    )

def ub_last_child_position(conn, parent_id: str) -> str | None:
    row = conn.execute(
        "SELECT position FROM unified_blocks WHERE parent_id = ? ORDER BY position DESC LIMIT 1",
        (parent_id,),
    ).fetchone()
    return row[0] if row else None

def ub_block_to_dict(row) -> dict:
    return {
        "id": row[0],
        "parent_id": row[1],
        "position": row[2],
        "content": row[3] or "",
        "properties": _json.loads(row[4] or "{}"),
        "created_at": row[5],
        "updated_at": row[6],
    }

# Pydantic models for unified blocks
class UBCreateRequest(BaseModel):
    parent_id: str
    content: str = ""
    properties: dict = {}
    before: str | None = None   # fractional position of the sibling before this one
    after: str | None = None    # fractional position of the sibling after this one

class UBUpdateRequest(BaseModel):
    content: str | None = None
    properties: dict | None = None

class UBReorderRequest(BaseModel):
    parent_id: str | None = None   # if provided, also reparents the block
    before: str | None = None
    after: str | None = None

class UBByDocCreate(BaseModel):
    default_title: str
    source_url: str | None = None

# Route order matters: static-prefix routes must come before /{id}

@app.get("/api/blocks/by-doc/{doc_id}")
async def ub_get_by_doc(doc_id: str):
    with sqlite3.connect(PAGES_DB) as conn:
        row = conn.execute(
            "SELECT id, parent_id, position, content, properties, created_at, updated_at "
            "FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?",
            (doc_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="block not found for doc_id")
    return ub_block_to_dict(row)

@app.post("/api/blocks/by-doc/{doc_id}")
async def ub_get_or_create_by_doc(doc_id: str, payload: UBByDocCreate):
    with sqlite3.connect(PAGES_DB) as conn:
        row = conn.execute(
            "SELECT id, parent_id, position, content, properties, created_at, updated_at "
            "FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?",
            (doc_id,),
        ).fetchone()
        if row:
            # Opportunistic backfill of source_url
            if payload.source_url:
                props = _json.loads(row[4] or "{}")
                if not props.get("source_url"):
                    props["source_url"] = payload.source_url
                    now = page_now()
                    conn.execute(
                        "UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?",
                        (_json.dumps(props), now, row[0]),
                    )
                    conn.commit()
            return ub_block_to_dict(row)

        # Create new block under root
        block_id = secrets.token_urlsafe(9)
        title = (payload.default_title or "").strip() or "Untitled"
        now = page_now()
        last_pos = ub_last_child_position(conn, "root")
        new_pos = generate_key_between(last_pos, None)
        props = {"doc_id": doc_id}
        if payload.source_url:
            props["source_url"] = payload.source_url
        conn.execute(
            "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
            "VALUES (?, 'root', ?, ?, ?, ?, ?)",
            (block_id, new_pos, title, _json.dumps(props), now, now),
        )
        conn.commit()
    return {
        "id": block_id, "parent_id": "root", "position": new_pos,
        "content": title, "properties": props, "created_at": now, "updated_at": now,
    }

@app.get("/api/blocks/{block_id}/children")
async def ub_get_children(block_id: str):
    with sqlite3.connect(PAGES_DB) as conn:
        if block_id != "root":
            if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
                raise HTTPException(status_code=404, detail="block not found")
        rows = conn.execute(
            "SELECT id, parent_id, position, content, properties, created_at, updated_at "
            "FROM unified_blocks WHERE parent_id = ? ORDER BY position ASC",
            (block_id,),
        ).fetchall()
    return {"children": [ub_block_to_dict(r) for r in rows]}

@app.get("/api/blocks/{block_id}/subtree")
async def ub_get_subtree(block_id: str):
    with sqlite3.connect(PAGES_DB) as conn:
        rows = ub_fetch_subtree(conn, block_id)
    if not rows:
        raise HTTPException(status_code=404, detail="block not found")
    # Build a full id→node map, wire children, then return the root node by id
    by_id: dict = {}
    for r in rows:
        by_id[r[0]] = {
            "id": r[0], "parent_id": r[1], "position": r[2],
            "content": r[3] or "", "properties": _json.loads(r[4] or "{}"),
            "created_at": r[5], "updated_at": r[6], "children": [],
        }
    for node in by_id.values():
        parent = by_id.get(node["parent_id"])
        if parent:
            parent["children"].append(node)
    for node in by_id.values():
        node["children"].sort(key=lambda n: n["position"])
    return {"block": by_id.get(block_id)}

@app.get("/api/blocks/{block_id}")
async def ub_get_block(block_id: str):
    with sqlite3.connect(PAGES_DB) as conn:
        row = conn.execute(
            "SELECT id, parent_id, position, content, properties, created_at, updated_at "
            "FROM unified_blocks WHERE id = ?",
            (block_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="block not found")
    return ub_block_to_dict(row)

@app.post("/api/blocks")
async def ub_create_block(payload: UBCreateRequest):
    block_id = secrets.token_urlsafe(9)
    now = page_now()
    with sqlite3.connect(PAGES_DB) as conn:
        if payload.parent_id != "root":
            if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (payload.parent_id,)).fetchone():
                raise HTTPException(status_code=404, detail="parent block not found")
        try:
            new_pos = generate_key_between(payload.before, payload.after)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"invalid before/after: {e}")
        conn.execute(
            "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (block_id, payload.parent_id, new_pos, payload.content,
             _json.dumps(payload.properties), now, now),
        )
        conn.commit()
    return {
        "id": block_id, "parent_id": payload.parent_id, "position": new_pos,
        "content": payload.content, "properties": payload.properties,
        "created_at": now, "updated_at": now,
    }

@app.put("/api/blocks/{block_id}")
async def ub_update_block(block_id: str, payload: UBUpdateRequest):
    now = page_now()
    with sqlite3.connect(PAGES_DB) as conn:
        row = conn.execute(
            "SELECT properties FROM unified_blocks WHERE id = ?", (block_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="block not found")
        sets = ["updated_at = ?"]
        values: list = [now]
        if payload.content is not None:
            sets.append("content = ?")
            values.append(payload.content)
        if payload.properties is not None:
            existing = _json.loads(row[0] or "{}")
            existing.update(payload.properties)
            sets.append("properties = ?")
            values.append(_json.dumps(existing))
        values.append(block_id)
        conn.execute(f"UPDATE unified_blocks SET {', '.join(sets)} WHERE id = ?", values)
        conn.commit()
    return {"ok": True, "updated_at": now}

@app.delete("/api/blocks/{block_id}")
async def ub_delete_block(block_id: str):
    if block_id == "root":
        raise HTTPException(status_code=400, detail="cannot delete root block")
    with sqlite3.connect(PAGES_DB) as conn:
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="block not found")
        ub_delete_subtree(conn, block_id)
        conn.commit()
    return {"ok": True, "id": block_id}

def ub_flatten_tree(tree, parent_id, result, now):
    """Recursively flatten a nested block tree into flat rows with fractional positions."""
    n = len(tree or [])
    if n == 0:
        return
    keys = generate_n_keys_between(None, None, n=n)
    for node, key in zip(tree, keys):
        props = node.get("properties") or {}
        if isinstance(props, str):
            try: props = _json.loads(props)
            except Exception: props = {}
        node_id = node.get("id") or secrets.token_urlsafe(9)
        result.append({
            "id": node_id,
            "parent_id": parent_id,
            "position": key,
            "content": node.get("content", "") or "",
            "properties": _json.dumps(props),
            "created_at": node.get("created_at") or now,
            "updated_at": now,
        })
        ub_flatten_tree(node.get("children") or [], node_id, result, now)

class UBPutChildrenRequest(BaseModel):
    blocks: list

@app.put("/api/blocks/{block_id}/children")
async def ub_put_children(block_id: str, payload: UBPutChildrenRequest):
    """Replace all children of a block with the provided nested tree."""
    now = page_now()
    rows: list = []
    ub_flatten_tree(payload.blocks, block_id, rows, now)
    with sqlite3.connect(PAGES_DB) as conn:
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="block not found")
        conn.execute(
            """
            WITH RECURSIVE subtree AS (
                SELECT id FROM unified_blocks WHERE parent_id = ?
                UNION ALL
                SELECT ub.id FROM unified_blocks ub JOIN subtree s ON ub.parent_id = s.id
            )
            DELETE FROM unified_blocks WHERE id IN (SELECT id FROM subtree)
            """,
            (block_id,),
        )
        for r in rows:
            conn.execute(
                "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (r["id"], r["parent_id"], r["position"], r["content"],
                 r["properties"], r["created_at"], r["updated_at"]),
            )
        conn.execute("UPDATE unified_blocks SET updated_at = ? WHERE id = ?", (now, block_id))
        conn.commit()
    return {"ok": True, "count": len(rows), "updated_at": now}

@app.post("/api/blocks/{block_id}/reorder")
async def ub_reorder_block(block_id: str, payload: UBReorderRequest):
    if block_id == "root":
        raise HTTPException(status_code=400, detail="cannot reorder root block")
    with sqlite3.connect(PAGES_DB) as conn:
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="block not found")
        try:
            new_pos = generate_key_between(payload.before, payload.after)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"invalid before/after: {e}")
        sets = ["position = ?", "updated_at = ?"]
        values: list = [new_pos, page_now()]
        if payload.parent_id is not None:
            sets.append("parent_id = ?")
            values.append(payload.parent_id)
        values.append(block_id)
        conn.execute(f"UPDATE unified_blocks SET {', '.join(sets)} WHERE id = ?", values)
        conn.commit()
    return {"ok": True, "id": block_id, "position": new_pos}
