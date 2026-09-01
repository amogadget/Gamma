"""The browser extension's endpoints (Gamma Connector).

One fat endpoint, ``POST /api/clip``, runs the whole "save this paper" ingest
that the app's ``openPdf`` orchestrates client-side: dedup by identifier,
resolve the link to a PDF, store a copy, create the page, file it, and kick
off the metadata lookup. The companions are read-only helpers for the popup
(``/api/library/lookup`` for the "already in your library" badge,
``/api/library/folders`` for the folder picker) and ``POST /api/clip/note``
for text selections clipped into a page. Session-only — never share-token
readable. Design: docs/dev/extension.md.
"""

import hashlib
import json
import re
import secrets
import sqlite3
import threading
import urllib.parse

from fastapi import APIRouter, HTTPException, Request
from fractional_indexing import generate_key_between
from pydantic import BaseModel

from .. import flatten_queue
from ..auth import require_user
from ..blocks_store import (
    BLOCK_COLUMNS,
    block_to_dict,
    get_or_create_doc_page,
    last_child_position,
)
from ..db import page_now, safe_doc_id, user_db_path, user_uploads_dir
from ..foldertags import add_tag, clean_path, clean_segment, parse_tags
from ..logbuf import log
from ..server_settings import can_store
from ..storage import DIGEST_CHARS
from .metadata import fetch_page_metadata
from .pdf import download_pdf, resolve_source

router = APIRouter(prefix="/api", tags=["clip"])

_DOI_RE = re.compile(r"(10\.\d{4,9}/[^\s?#\"'<>]+)", re.I)
_ARXIV_RE = re.compile(r"(?:arxiv(?:\.org/(?:abs|pdf)/|[:.]\s*)|^)([0-9]{4}\.[0-9]{4,5})(?:v\d+)?", re.I)

WEB_CLIPS_TITLE = "Web clips"


# --- identifiers ---------------------------------------------------------------

def norm_doi(text: str) -> str:
    m = _DOI_RE.search(urllib.parse.unquote(text or ""))
    return m.group(1).rstrip(".,;)]}").lower() if m else ""


def norm_arxiv(text: str) -> str:
    """Version-stripped arXiv id from a URL, "arXiv:…" string, or bare id."""
    m = _ARXIV_RE.search((text or "").strip())
    return m.group(1) if m else ""


def url_doc_id(source_url: str) -> str:
    """The proxy cache id for an external PDF URL (mirrors /api/pdf)."""
    return hashlib.sha256(source_url.encode()).hexdigest()[:DIGEST_CHARS]


def find_page(conn, doi: str = "", arxiv_id: str = "", urls: tuple = ()) -> dict | None:
    """The library page for a paper, by DOI, arXiv id, or any of its URLs.
    Identifier matches come from the metadata cache (properties.meta), the
    identifiers a previous clip recorded (clip_doi / clip_arxiv_id) and the
    source URL; URL matches from the proxy-cache hash, the stored source_url,
    or the web page the extension saved it from (web_url).

    clip_* matter because the metadata lookup runs off-request and may fail:
    without them, a paper saved from its PDF link would not be recognised when
    the same paper is later reached by its DOI, so it would be saved twice and
    the popup would keep offering to save it."""
    doi = (doi or "").lower()
    urls = tuple(u for u in urls if u)
    url_ids = {url_doc_id(u) for u in urls}
    rows = conn.execute(
        f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE parent_id = 'root' "
        "AND json_extract(properties, '$.doc_id') IS NOT NULL"
    ).fetchall()
    for row in rows:
        props = json.loads(row[4] or "{}")
        meta = props.get("meta") or {}
        src = str(props.get("source_url") or "")
        web = str(props.get("web_url") or "")
        if props.get("doc_id") in url_ids or (urls and (src in urls or web in urls)):
            return block_to_dict(row)
        if doi and (str(meta.get("doi") or "").lower() == doi
                    or str(props.get("clip_doi") or "").lower() == doi
                    or doi in src.lower() or norm_doi(web) == doi):
            return block_to_dict(row)
        if arxiv_id and (str(meta.get("arxiv_id") or "").split("v")[0] == arxiv_id
                         or str(props.get("clip_arxiv_id") or "") == arxiv_id
                         or norm_arxiv(src) == arxiv_id or norm_arxiv(web) == arxiv_id):
            return block_to_dict(row)
    return None


def _apply_tags(conn, block: dict, folder: str, labels: list[str]) -> dict:
    """File the page: folder paths and flat labels are both comma lists on
    the page's properties; adding is a soft link that keeps existing tags."""
    props = dict(block.get("properties") or {})
    changed = False
    path = clean_path(folder)
    if path:
        tags = parse_tags(props.get("folder"))
        if path not in tags:
            props["folder"] = ", ".join(add_tag(tags, path))
            changed = True
    cats = parse_tags(props.get("category"))
    for raw in labels or []:
        name = clean_segment(str(raw))
        if name and name not in cats:
            cats.append(name)
            props["category"] = ", ".join(cats)
            changed = True
    if changed:
        conn.execute(
            "UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?",
            (json.dumps(props), page_now(), block["id"]),
        )
        conn.commit()
        block = {**block, "properties": props}
    return block


def _start_metadata(user: str, block_id: str, doi: str = "", arxiv_id: str = "") -> None:
    """Metadata lookup off the request: arXiv → DOI → AI fallback can take
    seconds to minutes and the extension only needs the page id back. The
    detector's doi/arxiv_id ride along as trusted hints — they come from the
    publisher page's own meta tags, exactly what the lookup wants."""
    def run():
        try:
            fetch_page_metadata(user, block_id, doi=doi, arxiv_id=arxiv_id)
        except HTTPException as e:
            log.info(f"[clip] metadata for {block_id}: {e.detail}")
        except Exception as e:  # a failed lookup must not take the thread down noisily
            log.warning(f"[clip] metadata for {block_id} failed: {e}")
    threading.Thread(target=run, name=f"clip-meta-{block_id}", daemon=True).start()


def _clean_title(title: str) -> str:
    return re.sub(r"\s+", " ", (title or "").replace("\x00", "")).strip()[:500]


def _default_title(doc_id: str, source_url: str) -> str:
    tail = urllib.parse.unquote((source_url or "").split("/")[-1]).strip()
    return f"PDF Notes - {tail or doc_id}"


def _result(block: dict, existed: bool, note: str = "") -> dict:
    props = block.get("properties") or {}
    out = {
        "block_id": block["id"], "doc_id": props.get("doc_id", ""),
        "title": block.get("content", ""), "existed": existed,
        "open_url": f"/?block={urllib.parse.quote(block['id'])}",
        "folder": props.get("folder", ""), "labels": parse_tags(props.get("category")),
    }
    if note:
        out["note"] = note
    return out


# --- endpoints -----------------------------------------------------------------

class ClipRequest(BaseModel):
    source_url: str = ""          # the tab the user saved from (kept as properties.web_url)
    pdf_url: str = ""             # detector output; any may be empty
    doi: str = ""
    arxiv_id: str = ""
    doc_id: str = ""              # set when the PDF bytes were uploaded first (/api/uploads)
    title: str = ""               # citation_title / document.title
    folder: str = ""
    labels: list[str] = []
    allow_oa: bool = True         # substitute an open-access copy behind paywalls
    save_copy: bool = True        # store the PDF server-side (else proxy on open)
    fetch_metadata: bool = True


# Sync on purpose: resolving and downloading run in FastAPI's threadpool.
@router.post("/clip")
def clip(payload: ClipRequest, request: Request):
    user = require_user(request)
    source_url = (payload.source_url or "").strip()
    pdf_url = (payload.pdf_url or "").strip()
    doi = norm_doi(payload.doi) or norm_doi(pdf_url) or norm_doi(source_url)
    arxiv_id = norm_arxiv(payload.arxiv_id) or norm_arxiv(pdf_url) or norm_arxiv(source_url)
    title = _clean_title(payload.title)
    labels = [str(label) for label in (payload.labels or [])][:50]
    db_path = user_db_path(user, "pages.db")
    note = ""

    # 1. Dedup by identifier — the same paper reached via abs / pdf / DOI
    #    URLs hashes to different doc ids, so URL equality isn't enough.
    with sqlite3.connect(db_path) as conn:
        existing = find_page(conn, doi, arxiv_id, (pdf_url, source_url))
        if existing:
            block = _apply_tags(conn, existing, payload.folder, labels)
            return _result(block, existed=True)

    if payload.doc_id:
        # 2a. The extension uploaded the bytes itself (its browser session got
        #     past a paywall the server can't). The file must already exist.
        try:
            doc_id = safe_doc_id(payload.doc_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid doc_id")
        if not (user_uploads_dir(user) / f"{doc_id}.pdf").is_file():
            raise HTTPException(status_code=404, detail="no uploaded PDF with this doc_id — upload it first")
        page_source = f"/api/uploads/{doc_id}.pdf"
    else:
        # 2b. Resolve the best identifier to a fetchable PDF URL, then make
        #     sure it really delivers a PDF before any page exists — a dead
        #     link must not leave an empty page behind (same rule as openPdf).
        candidate = pdf_url or arxiv_id or doi or source_url
        if not candidate:
            raise HTTPException(status_code=400, detail="nothing to save: no URL or identifier")
        resolved = resolve_source(candidate, payload.allow_oa)
        page_source = resolved["source_url"]
        note = resolved.get("note", "")
        doc_id = url_doc_id(page_source)
        local = user_uploads_dir(user) / f"{doc_id}.pdf"
        if not local.is_file():
            _, data = download_pdf(page_source, want_bytes=payload.save_copy)
            if payload.save_copy:
                if can_store(user, len(data)):
                    local.parent.mkdir(parents=True, exist_ok=True)
                    local.write_bytes(data)
                    # Same treatment as an upload or a proxied save: scanned
                    # (MRC/JPEG 2000) papers get a flattened copy in the
                    # background, or the viewer renders them at ~1s/page.
                    flatten_queue.schedule(user, doc_id)
                else:
                    log.info(f"[clip] not caching {doc_id} ({len(data)} bytes): over storage limits")
                    note = (note + " " if note else "") + \
                        "Not stored: over your storage limit — the PDF is proxied on open."

    # 3. The page, filed and tagged.
    with sqlite3.connect(db_path) as conn:
        block = get_or_create_doc_page(
            conn, doc_id, title or _default_title(doc_id, page_source), page_source)
        props = dict(block.get("properties") or {})
        changed = False
        if source_url and not props.get("web_url") and source_url != page_source:
            props["web_url"] = source_url
            changed = True
        # Keep the identifiers this clip was given: they are what dedup and the
        # popup's badge match on until (or unless) the metadata lookup lands.
        if doi and not props.get("clip_doi"):
            props["clip_doi"] = doi
            changed = True
        if arxiv_id and not props.get("clip_arxiv_id"):
            props["clip_arxiv_id"] = arxiv_id
            changed = True
        if changed:
            conn.execute("UPDATE unified_blocks SET properties = ? WHERE id = ?",
                         (json.dumps(props), block["id"]))
            conn.commit()
            block = {**block, "properties": props}
        block = _apply_tags(conn, block, payload.folder, labels)

    # 4. Metadata, off the request.
    if payload.fetch_metadata and not (block.get("properties") or {}).get("meta"):
        _start_metadata(user, block["id"], doi=doi, arxiv_id=arxiv_id)
    return _result(block, existed=False, note=note)


@router.get("/library/lookup")
def library_lookup(request: Request, doi: str = "", arxiv_id: str = "", url: str = ""):
    """Is this paper already in the library? 404 when not."""
    user = require_user(request)
    url = (url or "").strip()
    doi = norm_doi(doi) or norm_doi(url)
    arxiv_id = norm_arxiv(arxiv_id) or norm_arxiv(url)
    if not (doi or arxiv_id or url):
        raise HTTPException(status_code=400, detail="doi, arxiv_id, or url required")
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        block = find_page(conn, doi, arxiv_id, (url,))
    if not block:
        raise HTTPException(status_code=404, detail="not in library")
    return _result(block, existed=True)


@router.get("/library/folders")
def library_folders(request: Request):
    """Folder paths (with their ancestors) and flat labels in use — the
    popup's pickers, without pulling every page down."""
    user = require_user(request)
    folders: set[str] = set()
    labels: set[str] = set()
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        rows = conn.execute(
            "SELECT json_extract(properties, '$.folder'), json_extract(properties, '$.category') "
            "FROM unified_blocks WHERE parent_id = 'root'"
        ).fetchall()
    for folder, category in rows:
        for path in parse_tags(folder):
            parts = [p for p in clean_path(path).split("/") if p]
            for i in range(1, len(parts) + 1):
                folders.add("/".join(parts[:i]))
        labels.update(parse_tags(category))
    return {"folders": sorted(folders, key=str.lower), "labels": sorted(labels, key=str.lower)}


class ClipNoteRequest(BaseModel):
    text: str
    source_url: str = ""
    title: str = ""
    page_id: str = ""             # empty → the account's "Web clips" note page


def _insert_last(conn, parent_id: str, content: str, props: dict, now: str) -> str:
    block_id = secrets.token_urlsafe(9)
    pos = generate_key_between(last_child_position(conn, parent_id), None)
    conn.execute(
        "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (block_id, parent_id, pos, content, json.dumps(props), now, now),
    )
    return block_id


@router.post("/clip/note")
def clip_note(payload: ClipNoteRequest, request: Request):
    """Append a quoted selection (with its source link) as the last block of
    a page — the one matching this tab, or the "Web clips" page (created on
    first use)."""
    user = require_user(request)
    text = (payload.text or "").replace("\r\n", "\n").strip()
    if not text:
        raise HTTPException(status_code=400, detail="nothing selected")
    text = text[:20_000]
    quote = "\n".join(f"> {line}" if line.strip() else ">" for line in text.split("\n"))
    src = (payload.source_url or "").strip()
    label = _clean_title(payload.title)[:200] or src
    content = quote + (f"\n— [{label}]({src})" if src else "")
    now = page_now()
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        page_id = (payload.page_id or "").strip()
        if page_id:
            if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (page_id,)).fetchone():
                raise HTTPException(status_code=404, detail="page not found")
        else:
            row = conn.execute(
                "SELECT id FROM unified_blocks WHERE parent_id = 'root' "
                "AND json_extract(properties, '$.web_clips') = 1 LIMIT 1"
            ).fetchone()
            page_id = row[0] if row else _insert_last(conn, "root", WEB_CLIPS_TITLE, {"web_clips": 1}, now)
        block_id = _insert_last(conn, page_id, content, {}, now)
        conn.execute("UPDATE unified_blocks SET updated_at = ? WHERE id = ?", (now, page_id))
        conn.commit()
    return {"block_id": block_id, "page_id": page_id,
            "open_url": f"/?block={urllib.parse.quote(block_id)}"}
