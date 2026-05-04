import secrets
import json
import re
import random
import string
import bcrypt
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from urllib.request import Request as URLRequest, urlopen
from urllib.error import URLError, HTTPError
from pydantic import BaseModel
import aiosqlite
from pathlib import Path

app = FastAPI()

# Per-user data paths
USERS_DB = Path(__file__).parent / "users.db"
USERS_DIR = Path(__file__).parent / "users"

def _ensure_users_db():
    conn = __import__("sqlite3").connect(str(USERS_DB))
    conn.execute("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, is_guest INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username), guest_date TEXT, created_at TEXT NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, username TEXT NOT NULL, doc_id TEXT NOT NULL, created_at TEXT NOT NULL)")
    conn.commit()
    return conn

_ensure_users_db().close()


# --- Auth middleware ---

@app.middleware("http")
async def session_middleware(request: Request, call_next):
    import sqlite3 as _sqlite3
    token = request.cookies.get("session")
    request.state.user = None
    request.state.is_guest = False
    if token:
        with _sqlite3.connect(str(USERS_DB)) as conn:
            row = conn.execute(
                "SELECT u.username, u.is_guest, s.guest_date FROM sessions s JOIN users u ON s.username = u.username WHERE s.token = ?",
                (token,),
            ).fetchone()
            if row:
                username, is_guest, guest_date = row
                if is_guest:
                    today = __import__("datetime").datetime.utcnow().strftime("%Y-%m-%d")
                    if guest_date != today:
                        # New day — wipe and recreate guest databases
                        conn.execute("DELETE FROM sessions WHERE username = 'guest'")
                        conn.commit()
                        _reset_guest_data()
                        # Create new session
                        new_token = secrets.token_urlsafe(32)
                        conn.execute("INSERT INTO sessions (token, username, guest_date, created_at) VALUES (?, 'guest', ?, ?)",
                                     (new_token, today, page_now()))
                        conn.commit()
                        token = new_token
                        username = "guest"
                        is_guest = True
                        # We'll set the cookie later; for now store on request.state
                        request.state._new_session_token = new_token
                request.state.user = username
                request.state.is_guest = bool(is_guest)
    response = await call_next(request)
    if hasattr(request.state, '_new_session_token'):
        response.set_cookie("session", request.state._new_session_token, httponly=True, samesite="lax", max_age=365*24*3600)
    return response


def _reset_guest_data():
    """Wipe and recreate guest databases."""
    import sqlite3 as _sqlite3
    import shutil
    guest_dir = USERS_DIR / "guest"
    if guest_dir.exists():
        shutil.rmtree(str(guest_dir))
    guest_dir.mkdir(parents=True, exist_ok=True)
    nw = page_now()
    pages_db = _sqlite3.connect(str(guest_dir / "pages.db"))
    pages_db.execute("CREATE TABLE unified_blocks (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES unified_blocks(id), position TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', properties TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
    pages_db.execute("CREATE INDEX idx_ub_parent ON unified_blocks(parent_id, position)")
    pages_db.execute("INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) VALUES ('root', NULL, 'a0', '', '{}', ?, ?)", (nw, nw))
    # Create welcome page for guest — structured as nested blocks
    # GitHub raw base for embedded screenshots
    raw = "https://raw.githubusercontent.com/amogadget/Gamma/main/docs/screenshots"
    wid = secrets.token_urlsafe(9)
    intro_id = secrets.token_urlsafe(9)
    started_id = secrets.token_urlsafe(9)
    figures_id = secrets.token_urlsafe(9)
    guest_id = secrets.token_urlsafe(9)
    md_id = secrets.token_urlsafe(9)
    blocks = [
        (wid, "root", "a0V", "Welcome", '{"summary":"A quick-start guide to Gamma PDF Annotator"}'),
        (intro_id, wid, "a0", "Gamma is a self-hosted, Logseq-inspired PDF annotation tool. You can highlight PDFs, organize notes as nested outliner blocks, and share read-only annotated copies via link.", '{}'),
        (started_id, wid, generate_key_between("a0", None), "## Getting started", '{}'),
        (secrets.token_urlsafe(9), started_id, "a0", "**Open a PDF**: paste a URL in the topbar and click Open, or drag a PDF file onto this page.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a0", None), "**Highlight text**: select text in the PDF to create a highlight with optional comment and color.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a0V", None), "**Add notes**: type in any block. Press Enter for a new sibling, Tab to indent, Shift+Tab to outdent.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a1", None), "**Reorder blocks**: hover over a block's left edge, grab the ⋮⋮ handle, and drag to reorder.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a1V", None), "**Drag images**: drag an image file from your computer onto any block to insert it. You can also paste images from the clipboard.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a2", None), "**AI chat**: click \"Show AI Chat\" at the bottom of the sidebar to ask questions about the open PDF.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a2V", None), "**Share**: click \"Share link\" in the ⋮ menu to generate a public read-only link for any annotated PDF.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a3", None), "**Category tags**: add a `category::` tag below the summary to organize pages. The home page groups them into carousels.", '{}'),
        (figures_id, wid, generate_key_between("a0V", None), "## Insert figures", '{}'),
        (secrets.token_urlsafe(9), figures_id, "a0", f"Drag any image file into a block to embed it. Gamma uploads it and inserts `![]()` markdown. Here is what the app looks like:", '{}'),
        (secrets.token_urlsafe(9), figures_id, generate_key_between("a0", None), f"![]({raw}/01-annotated-pdf.png)", '{}'),
        (secrets.token_urlsafe(9), figures_id, generate_key_between("a0V", None), f"![]({raw}/02-home-carousels.png)", '{}'),
        (guest_id, wid, generate_key_between("a1", None), "## Guest account", '{}'),
        (secrets.token_urlsafe(9), guest_id, "a0", "You are logged in as a **guest**. Your data resets each day at midnight UTC. To keep your work permanently, ask the admin to create an account for you.", '{}'),
        (md_id, wid, generate_key_between("a1V", None), "## Markdown formatting", '{}'),
        (secrets.token_urlsafe(9), md_id, "a0", "Blocks support **bold**, *italic*, `code`, [links](https://example.com), and inline $\\KaTeX$ math like $E = mc^2$.", '{}'),
    ]
    for bid, pid, pos, content, props in blocks:
        pages_db.execute(
            "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (bid, pid, pos, content, props or '{}', nw, nw),
        )
    pages_db.commit()
    pages_db.close()
    data_db = _sqlite3.connect(str(guest_dir / "data.db"))
    data_db.execute("CREATE TABLE IF NOT EXISTS annotations (doc_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    data_db.execute("CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, doc_id TEXT NOT NULL)")
    data_db.commit()
    data_db.close()
    (guest_dir / "uploads").mkdir(parents=True, exist_ok=True)


def _require_user(request: Request) -> str:
    """Return username or raise 401."""
    user = request.state.user
    if not user:
        raise HTTPException(status_code=401)
    return user


def _user_db(request: Request, db_name: str) -> str:
    """Return per-user database path or raise 401."""
    return str(USERS_DIR / _require_user(request) / db_name)


def _user_uploads(request: Request) -> Path:
    """Return per-user uploads directory or raise 401."""
    return USERS_DIR / _require_user(request) / "uploads"

def _resolve_user(request: Request) -> str:
    """Return user for DB access. Uses session if logged in, falls back to ?user= param (for shared links)."""
    user = request.state.user
    if user:
        return user
    user = request.query_params.get("user")
    if user:
        return user
    raise HTTPException(status_code=401)

def _db_for(user: str, db_name: str) -> str:
    return str(USERS_DIR / user / db_name)

def _uploads_for(user: str) -> Path:
    return USERS_DIR / user / "uploads"


class AnnotationDoc(BaseModel):
    data: str

class ShareRequest(BaseModel):
    source_url: str

class ResolvePdfRequest(BaseModel):
    source_url: str


@app.get("/api/health")
async def health():
    return {"ok": True}


# --- Auth endpoints ---

class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/login")
async def login(payload: LoginRequest, request: Request):
    import sqlite3 as _sqlite3
    with _sqlite3.connect(str(USERS_DB)) as conn:
        row = conn.execute(
            "SELECT username, password_hash, is_guest FROM users WHERE username = ?",
            (payload.username,),
        ).fetchone()
    if not row or row[2]:  # guest accounts have no password
        raise HTTPException(status_code=401, detail="invalid credentials")
    if not bcrypt.checkpw(payload.password.encode(), row[1].encode()):
        raise HTTPException(status_code=401, detail="invalid credentials")
    token = secrets.token_urlsafe(32)
    with _sqlite3.connect(str(USERS_DB)) as conn:
        conn.execute(
            "INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)",
            (token, row[0], page_now()),
        )
        conn.commit()
    import json as _json_inner
    body = _json_inner.dumps({"ok": True, "username": row[0]})
    resp = Response(content=body, media_type="application/json", status_code=200)
    resp.set_cookie("session", token, httponly=True, samesite="lax", max_age=365*24*3600)
    return resp


@app.post("/api/logout")
async def logout(request: Request):
    token = request.cookies.get("session")
    if token:
        import sqlite3 as _sqlite3
        with _sqlite3.connect(str(USERS_DB)) as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
    resp = Response(content='{"ok":true}', media_type="application/json", status_code=200)
    resp.delete_cookie("session")
    return resp


@app.get("/api/session")
async def get_session(request: Request):
    user = request.state.user
    if not user:
        return {"user": None}
    return {"user": user, "is_guest": request.state.is_guest}


@app.post("/api/login-guest")
async def login_guest(request: Request):
    import sqlite3 as _sqlite3
    # Ensure guest user exists
    with _sqlite3.connect(str(USERS_DB)) as conn:
        guest = conn.execute("SELECT 1 FROM users WHERE username = 'guest'").fetchone()
        if not guest:
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES ('guest', '', 1, ?)",
                (page_now(),),
            )
            conn.commit()
        today = __import__("datetime").datetime.utcnow().strftime("%Y-%m-%d")
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions (token, username, guest_date, created_at) VALUES (?, 'guest', ?, ?)",
            (token, today, page_now()),
        )
        conn.commit()
    # Ensure guest databases exist
    guest_pages = USERS_DIR / "guest" / "pages.db"
    if not guest_pages.exists():
        _reset_guest_data()
    resp = Response(content='{"ok":true,"username":"guest"}', media_type="application/json", status_code=200)
    resp.set_cookie("session", token, httponly=True, samesite="lax", max_age=365*24*3600)
    return resp



# --- AI chat (uses ANTHROPIC_ env vars for API key + base URL) ---
import os

AI_API_KEY = os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
AI_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
AI_MODEL = os.environ.get("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash")

class AIChatRequest(BaseModel):
    prompt: str
    doc_id: str = ""
    history: list = []  # [{role: "user"|"ai", text: str}, ...]

def _build_messages(payload, context):
    """Build the messages array with chat history and PDF context.
    Context is prepended to the first user message. History is included
    for multi-turn conversations."""
    msgs = []
    has_context = bool(context)
    context_used = False
    for h in (payload.history or []):
        role = "user" if h.get("role") != "ai" else "ai"
        content = h.get("text", "")
        if role == "user" and has_context and not context_used:
            content = f"Here is the PDF text:\n\n{context}\n\nUser question: {content}"
            context_used = True
        msgs.append({"role": role, "content": content})
    # Always append the current prompt
    content = payload.prompt
    if has_context and not context_used:
        content = f"Here is the PDF text:\n\n{context}\n\nUser question: {content}"
    msgs.append({"role": "user", "content": content})
    return msgs


@app.post("/api/ai/chat")
async def ai_chat(payload: AIChatRequest, request: Request):
    if not AI_API_KEY:
        raise HTTPException(status_code=503, detail="AI not configured (missing ANTHROPIC_AUTH_TOKEN)")

    user = _require_user(request)
    uploads = _uploads_for(user)

    # Build context: extract PDF text if doc_id provided
    context = ""
    extracted = ""
    if payload.doc_id:
        pdf_path = uploads / f"{payload.doc_id}.pdf"
        if not pdf_path.exists():
            # PDF not saved locally yet — try download from source_url if we have one
            print(f"[ai_chat] PDF NOT FOUND at {pdf_path}, attempting download from source_url")
            try:
                import sqlite3
                with sqlite3.connect(_db_for(user, "pages.db")) as conn:
                    row = conn.execute(
                        "SELECT properties FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?",
                        (payload.doc_id,),
                    ).fetchone()
                if row:
                    props = _json.loads(row[0] or "{}")
                    src = props.get("source_url") or props.get("sourceUrl") or ""
                    if src:
                        from urllib.request import Request as _Req, urlopen as _urlopen
                        dl_req = _Req(src, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/pdf,*/*;q=0.8"})
                        with _urlopen(dl_req, timeout=30) as dl_resp:
                            pdf_data = dl_resp.read()
                        uploads.mkdir(parents=True, exist_ok=True)
                        pdf_path.write_bytes(pdf_data)
                        print(f"[ai_chat] downloaded {len(pdf_data)} bytes from {src}")
            except Exception as dl_err:
                print(f"[ai_chat] download failed: {dl_err}")

        if pdf_path.exists():
            try:
                from PyPDF2 import PdfReader
                reader = PdfReader(str(pdf_path))
                pages_text = []
                for page in reader.pages:
                    t = page.extract_text()
                    if t:
                        pages_text.append(t)
                context = "\n\n".join(pages_text)
                extracted = f"{len(pages_text)} pages, {len(context)} chars"
                if len(context) > 8000:
                    context = context[:8000] + "\n…[truncated]"
            except Exception as e:
                context = "(PDF text extraction failed)"
                print(f"[ai_chat] extraction error: {e}")
        else:
            print(f"[ai_chat] PDF still not found after download attempt")

    print(f"[ai_chat] context={extracted or repr(context)}")

    import urllib.request as _ur
    body = _json.dumps({
        "model": AI_MODEL,
        "max_tokens": 4096,
        "system": f"You are a research assistant helping the user understand a PDF they are reading. The user may ask questions about the document. Be concise and reference specific parts of the text when relevant." if context else "",
        "messages": _build_messages(payload, context),
    }).encode()
    req = _ur.Request(f"{AI_BASE_URL}/v1/messages", data=body, headers={
        "x-api-key": AI_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    })
    try:
        with _ur.urlopen(req, timeout=30) as resp:
            data = _json.loads(resp.read())
        text = "".join(c.get("text", "") for c in data.get("content", []) if c.get("type") == "text")
        print(f"[ai_chat] response: {text[:200]}...")
        return {"response": text}
    except Exception as e:
        print(f"[ai_chat] API error: {e}")
        raise HTTPException(status_code=502, detail=f"AI call failed: {e}")


@app.get("/api/annotations/{doc_id}")
async def get_annotations(doc_id: str, request: Request):
    async with aiosqlite.connect(_user_db(request, "data.db")) as db:
        async with db.execute(
            "SELECT data FROM annotations WHERE doc_id = ?",
            (doc_id,)
        ) as cursor:
            row = await cursor.fetchone()

    if row is None:
        return {"data": '{"version":1,"annotations":[]}'}

    return {"data": row[0]}


@app.put("/api/annotations/{doc_id}")
async def put_annotations(doc_id: str, payload: AnnotationDoc, request: Request):
    async with aiosqlite.connect(_user_db(request, "data.db")) as db:
        await db.execute("""
            INSERT INTO annotations (doc_id, data)
            VALUES (?, ?)
            ON CONFLICT(doc_id) DO UPDATE SET data = excluded.data
        """, (doc_id, payload.data))
        await db.commit()

    return {"ok": True}

@app.post("/api/share/{doc_id}")
async def create_share(doc_id: str, request: Request):
    import sqlite3 as _sqlite3
    user = _require_user(request)
    with _sqlite3.connect(str(USERS_DB)) as conn:
        # Reuse existing share for this doc+user
        row = conn.execute(
            "SELECT token FROM shares WHERE username = ? AND doc_id = ?",
            (user, doc_id),
        ).fetchone()
        if row:
            return {"token": row[0]}
        token = secrets.token_urlsafe(12)
        conn.execute(
            "INSERT INTO shares (token, username, doc_id, created_at) VALUES (?, ?, ?, ?)",
            (token, user, doc_id, page_now()),
        )
        conn.commit()
    return {"token": token}

@app.get("/api/share/{token}")
async def get_share(token: str):
    import sqlite3 as _sqlite3
    with _sqlite3.connect(str(USERS_DB)) as conn:
        row = conn.execute(
            "SELECT doc_id, username FROM shares WHERE token = ?",
            (token,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="share not found")
    return {"doc_id": row[0], "username": row[1]}

@app.post("/api/resolve-pdf")
async def resolve_pdf(payload: ResolvePdfRequest, request: Request):
    _require_user(request)
    try:
        req = URLRequest(
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
async def proxy_pdf(source_url: str, request: Request):
    user = _resolve_user(request)
    uploads = USERS_DIR / user / "uploads"
    try:
        req = URLRequest(
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

        # Save a local copy so the AI chat endpoint can extract text from it.
        pdf_doc_id = hashlib.sha256(source_url.encode()).hexdigest()[:24]
        local_path = uploads / f"{pdf_doc_id}.pdf"
        if not local_path.exists():
            local_path.write_bytes(data)

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

def page_now():
    # Emit UTC ISO string with Z suffix so clients parse it correctly.
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"

# --- uploads (PDF file upload with content-hash dedup) ---
import hashlib
from fastapi import UploadFile, File

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB

@app.post("/api/uploads")
async def upload_pdf(file: UploadFile = File(...), request: Request = None):
    user = _require_user(request)
    uploads = _uploads_for(user)
    uploads.mkdir(parents=True, exist_ok=True)
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB)")
    if len(contents) < 4 or contents[:4] != b"%PDF":
        raise HTTPException(status_code=400, detail="not a valid PDF (missing %PDF header)")

    digest = hashlib.sha256(contents).hexdigest()[:24]
    target = uploads / f"{digest}.pdf"

    if not target.exists():
        target.write_bytes(contents)

    return {
        "doc_id": digest,
        "source_url": f"/api/uploads/{digest}.pdf",
        "size": len(contents),
        "already_existed": target.exists() and target.stat().st_size == len(contents)
    }

ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
IMAGE_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg"}

@app.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...), request: Request = None):
    user = _require_user(request)
    uploads = _uploads_for(user)
    uploads.mkdir(parents=True, exist_ok=True)
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"unsupported image type: {file.content_type}")
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB)")
    digest = hashlib.sha256(contents).hexdigest()[:24]
    ext = IMAGE_EXTENSIONS[file.content_type]
    target = uploads / f"{digest}{ext}"
    already_existed = target.exists() and target.stat().st_size == len(contents)
    if not already_existed:
        target.write_bytes(contents)
    return {
        "url": f"/api/uploads/{digest}{ext}",
        "size": len(contents),
        "already_existed": already_existed
    }

IMAGE_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}

def _find_upload_file(filename: str, request: Request) -> Path | None:
    """Search for an uploaded file. Checks session user first, then ?user= param, then all users."""
    user = request.state.user
    if user:
        path = USERS_DIR / user / "uploads" / filename
        if path.is_file():
            return path
    param_user = request.query_params.get("user")
    if param_user:
        path = USERS_DIR / param_user / "uploads" / filename
        if path.is_file():
            return path
    # Fallback: search all user directories (for shared links without ?user=)
    if USERS_DIR.exists():
        for d in USERS_DIR.iterdir():
            if d.is_dir():
                path = d / "uploads" / filename
                if path.is_file():
                    return path
    return None

@app.get("/api/uploads/{filename}")
async def serve_upload(filename: str, request: Request):
    # Sanitize: only allow [hex].ext pattern, no path traversal
    dot = filename.rfind(".")
    if dot < 0:
        raise HTTPException(status_code=400, detail="invalid filename")
    stem = filename[:dot]
    ext = filename[dot:].lower()
    if ext == ".pdf":
        media_type = "application/pdf"
    elif ext in IMAGE_MEDIA_TYPES:
        media_type = IMAGE_MEDIA_TYPES[ext]
    else:
        raise HTTPException(status_code=400, detail="unsupported file type")
    if not stem or not all(c in "0123456789abcdef" for c in stem):
        raise HTTPException(status_code=400, detail="invalid filename")
    path = _find_upload_file(filename, request)
    if not path:
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=3600"})


import json as _json


@app.get("/api/block-search")
async def block_search(q: str = "", ids: str = "", limit: int = 10, request: Request = None):
    results = []
    with sqlite3.connect(_user_db(request, "pages.db")) as conn:
        if ids:
            id_list = [i.strip() for i in ids.split(",") if i.strip()]
            if not id_list:
                return {"blocks": []}
            placeholders = ",".join("?" * len(id_list))
            rows = conn.execute(
                f"SELECT id, content, parent_id FROM unified_blocks WHERE id IN ({placeholders})",
                id_list,
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, content, parent_id
                FROM unified_blocks
                WHERE content LIKE ? AND content != ''
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (f"%{q}%", limit),
            ).fetchall()
        if not rows:
            return {"blocks": []}

        # Fetch all ancestor chains in one recursive CTE
        row_ids = [r[0] for r in rows]
        id_placeholders = ",".join("?" * len(row_ids))
        anc_rows = conn.execute(
            f"""
            WITH RECURSIVE chain AS (
                SELECT id AS descendant_id, parent_id, 0 AS depth
                FROM unified_blocks WHERE id IN ({id_placeholders})
                UNION ALL
                SELECT c.descendant_id, u.parent_id, c.depth + 1
                FROM unified_blocks u
                JOIN chain c ON u.id = c.parent_id
                WHERE u.parent_id IS NOT NULL AND u.parent_id != 'root'
            )
            SELECT c.descendant_id, u.id, u.content, c.depth
            FROM chain c
            JOIN unified_blocks u ON u.id = c.parent_id
            ORDER BY c.descendant_id, c.depth DESC
            """,
            row_ids,
        ).fetchall()

        # Build ancestor lookup: descendant_id → [(id, content), ...] from root to parent
        ancestors_by_id: dict = {}
        page_root_by_id: dict = {}
        for descendant_id, anc_id, anc_content, depth in anc_rows:
            if anc_id == "root":
                continue  # "root" is a virtual parent, not a real page
            ancestors_by_id.setdefault(descendant_id, []).append({"id": anc_id, "content": anc_content})
            if descendant_id not in page_root_by_id:
                page_root_by_id[descendant_id] = anc_id

        for r in rows:
            block_id, content, parent_id = r[0], r[1], r[2]
            block = {"id": block_id, "content": content}
            ancestors = ancestors_by_id.get(block_id)
            if ancestors:
                block["ancestors"] = ancestors
                block["page_root_id"] = page_root_by_id.get(block_id, block_id)
                block["page_title"] = ancestors[0]["content"]
            else:
                block["page_root_id"] = block_id
                block["page_title"] = content
            results.append(block)
    return {"blocks": results}


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
    request: Request = None,
):
    # 1. Validate and store PDF
    user = _require_user(request)
    uploads = _uploads_for(user)
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
            'color': _map_color((h.get('properties') or {}).get('color', 'yellow')),
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
    with sqlite3.connect(_db_for(user, "pages.db")) as conn:
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

def cleanup_orphan_uploads(conn, uploads_dir):
    """Delete files in the given uploads_dir that are no longer referenced by any block in conn."""
    if not uploads_dir.exists():
        return []
    removed = []
    for f in uploads_dir.iterdir():
        if not f.is_file():
            continue
        filename = f.name
        stem = f.stem
        ref = conn.execute(
            "SELECT 1 FROM unified_blocks "
            "WHERE json_extract(properties, '$.doc_id') = ? "
            "   OR content LIKE ? "
            "   OR properties LIKE ? "
            "LIMIT 1",
            (stem, f"%/api/uploads/{filename}%", f"%/api/uploads/{filename}%"),
        ).fetchone()
        if not ref:
            try:
                f.unlink()
                removed.append(filename)
            except OSError:
                pass
    return removed

# Clean up orphaned uploads across all users on startup
import sqlite3 as _sqlite3
if USERS_DIR.exists():
    for _ud in USERS_DIR.iterdir():
        if _ud.is_dir():
            _uploads = _ud / "uploads"
            _pages = _ud / "pages.db"
            if _uploads.exists() and _pages.exists():
                with _sqlite3.connect(str(_pages)) as _conn:
                    _removed = cleanup_orphan_uploads(_conn, _uploads)
                    if _removed:
                        print(f"[startup] removed orphan uploads for {_ud.name}: {_removed}")

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
async def ub_get_by_doc(doc_id: str, request: Request):
    with sqlite3.connect(_db_for(_resolve_user(request), "pages.db")) as conn:
        row = conn.execute(
            "SELECT id, parent_id, position, content, properties, created_at, updated_at "
            "FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?",
            (doc_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="block not found for doc_id")
    return ub_block_to_dict(row)

@app.post("/api/blocks/by-doc/{doc_id}")
async def ub_get_or_create_by_doc(doc_id: str, payload: UBByDocCreate, request: Request):
    with sqlite3.connect(_db_for(_resolve_user(request), "pages.db")) as conn:
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
async def ub_get_children(block_id: str, request: Request):
    with sqlite3.connect(_db_for(_resolve_user(request), "pages.db")) as conn:
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
async def ub_get_subtree(block_id: str, request: Request):
    with sqlite3.connect(_db_for(_resolve_user(request), "pages.db")) as conn:
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
async def ub_get_block(block_id: str, request: Request):
    with sqlite3.connect(_db_for(_resolve_user(request), "pages.db")) as conn:
        row = conn.execute(
            "SELECT id, parent_id, position, content, properties, created_at, updated_at "
            "FROM unified_blocks WHERE id = ?",
            (block_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="block not found")
    return ub_block_to_dict(row)

@app.post("/api/blocks")
async def ub_create_block(payload: UBCreateRequest, request: Request):
    block_id = secrets.token_urlsafe(9)
    now = page_now()
    with sqlite3.connect(_user_db(request, "pages.db")) as conn:
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
async def ub_update_block(block_id: str, payload: UBUpdateRequest, request: Request):
    now = page_now()
    with sqlite3.connect(_user_db(request, "pages.db")) as conn:
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
async def ub_delete_block(block_id: str, request: Request):
    if block_id == "root":
        raise HTTPException(status_code=400, detail="cannot delete root block")
    user = _require_user(request)
    with sqlite3.connect(_db_for(user, "pages.db")) as conn:
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="block not found")
        ub_delete_subtree(conn, block_id)
        conn.commit()
        removed = cleanup_orphan_uploads(conn, _uploads_for(user))
    return {"ok": True, "id": block_id, "removed_uploads": removed}

@app.post("/api/cleanup-uploads")
async def manual_cleanup_uploads(request: Request):
    user = _require_user(request)
    with sqlite3.connect(_db_for(user, "pages.db")) as conn:
        removed = cleanup_orphan_uploads(conn, _uploads_for(user))
    return {"ok": True, "removed_uploads": removed}

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
async def ub_put_children(block_id: str, payload: UBPutChildrenRequest, request: Request):
    """Replace all children of a block with the provided nested tree."""
    now = page_now()
    rows: list = []
    ub_flatten_tree(payload.blocks, block_id, rows, now)
    user = _require_user(request)
    with sqlite3.connect(_db_for(user, "pages.db")) as conn:
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
        removed = cleanup_orphan_uploads(conn, _uploads_for(user))
    return {"ok": True, "count": len(rows), "updated_at": now, "removed_uploads": removed}

@app.post("/api/blocks/{block_id}/reorder")
async def ub_reorder_block(block_id: str, payload: UBReorderRequest, request: Request):
    if block_id == "root":
        raise HTTPException(status_code=400, detail="cannot reorder root block")
    with sqlite3.connect(_user_db(request, "pages.db")) as conn:
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


@app.get("/api/blocks/{block_id}/backlinks")
async def ub_get_backlinks(block_id: str, request: Request):
    """Return all blocks that reference `block_id` via [[block_id]] syntax."""
    with sqlite3.connect(_db_for(_resolve_user(request), "pages.db")) as conn:
        rows = conn.execute(
            "SELECT id, content, parent_id FROM unified_blocks "
            "WHERE id != ? AND content LIKE ? "
            "ORDER BY updated_at DESC LIMIT 50",
            (block_id, f"%[[{block_id}]]%"),
        ).fetchall()

        if not rows:
            return {"backlinks": []}

        # Collect ancestor chains via CTE (same pattern as block_search)
        row_ids = [r[0] for r in rows]
        id_placeholders = ",".join("?" * len(row_ids))
        anc_rows = conn.execute(
            f"""
            WITH RECURSIVE chain AS (
                SELECT id AS descendant_id, parent_id, 0 AS depth
                FROM unified_blocks WHERE id IN ({id_placeholders})
                UNION ALL
                SELECT c.descendant_id, u.parent_id, c.depth + 1
                FROM unified_blocks u
                JOIN chain c ON u.id = c.parent_id
                WHERE u.parent_id IS NOT NULL AND u.parent_id != 'root'
            )
            SELECT c.descendant_id, u.id, u.content, c.depth
            FROM chain c
            JOIN unified_blocks u ON u.id = c.parent_id
            WHERE u.id != 'root'
            ORDER BY c.descendant_id, c.depth DESC
            """,
            row_ids,
        ).fetchall()

        ancestors_by_id: dict = {}
        page_root_by_id: dict = {}
        for descendant_id, anc_id, anc_content, depth in anc_rows:
            ancestors_by_id.setdefault(descendant_id, []).append({"id": anc_id, "content": anc_content})
            if descendant_id not in page_root_by_id:
                page_root_by_id[descendant_id] = anc_id

        results = []
        for r in rows:
            bid, content, parent_id = r[0], r[1], r[2]
            ancestors = ancestors_by_id.get(bid)
            results.append({
                "id": bid,
                "content": content,
                "page_root_id": page_root_by_id.get(bid, bid),
                "page_title": ancestors[0]["content"] if ancestors else content,
            })
    return {"backlinks": results}


