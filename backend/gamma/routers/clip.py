"""The browser extension's endpoints (Gamma Connector).

One fat endpoint, ``POST /api/clip``, runs the whole "save this page" ingest
that the app's ``openPdf`` orchestrates client-side: dedup by identifier,
resolve the link to a PDF, store a copy, create the page, file it, and kick
off the metadata lookup. When no PDF can be resolved the clip still becomes a
page — one carrying the tab's URL as ``properties.web_url`` (and the clipped
selection as its first block) instead of a PDF attachment. The companions are
read-only helpers for the popup (``/api/library/lookup`` for the "already in
your library" badge, ``/api/library/preview`` for the paper's registry title
before it is saved, ``/api/library/folders`` for the folder picker) and
``POST /api/clip/note`` for text selections appended into an existing page.
Session-only — never share-token readable. Design: docs/dev/extension.md.
"""

import hashlib
import json
import re
import secrets
import threading
import urllib.parse

from fastapi import APIRouter, HTTPException, Request
from fractional_indexing import generate_key_between
from pydantic import BaseModel

from ..auth import require_user, require_ws
from ..blocks_store import (
    BLOCK_COLUMNS,
    block_to_dict,
    create_page,
    get_or_create_doc_page,
    last_child_position,
    page_attachment,
)
from ..db import connect_pages_db, page_now, safe_doc_id, ws_uploads_dir
from ..foldertags import add_tag, clean_path, clean_segment, parse_tags
from ..logbuf import log
from ..ops import after_commit, apply_ops, props_patch
from ..server_settings import can_store
from ..storage import DIGEST_CHARS, url_filename
from .metadata import fetch_page_metadata, registry_record
from .pdf import download_pdf, resolve_source

router = APIRouter(prefix="/api", tags=["clip"])

_DOI_RE = re.compile(r"(10\.\d{4,9}/[^\s?#\"'<>]+)", re.I)
_ARXIV_RE = re.compile(r"(?:arxiv(?:\.org/(?:abs|pdf)/|[:.]\s*)|^)([0-9]{4}\.[0-9]{4,5})(?:v\d+)?", re.I)

WEB_CLIPS_TITLE = "Web clips"


# --- identifiers ---------------------------------------------------------------

_DOI_PATH_TAIL_RE = re.compile(r"(?:/(?:e?pdf|full|abs(?:tract)?|meta|download))?(?:\.pdf)?$", re.I)


def norm_doi(text: str) -> str:
    """The first DOI in a string, lowercased. Publisher URLs build paths on
    the DOI (APS ``/prl/pdf/<doi>``, Springer ``/content/pdf/<doi>.pdf``, IOP
    ``/article/<doi>/pdf``) — the view/file suffix is not part of it."""
    m = _DOI_RE.search(urllib.parse.unquote(text or ""))
    if not m:
        return ""
    return _DOI_PATH_TAIL_RE.sub("", m.group(1).rstrip(".,;)]}")).lower()


def norm_arxiv(text: str) -> str:
    """Version-stripped arXiv id from a URL, "arXiv:…" string, or bare id."""
    m = _ARXIV_RE.search((text or "").strip())
    return m.group(1) if m else ""


def url_doc_id(source_url: str) -> str:
    """The proxy cache id for an external PDF URL (mirrors /api/pdf)."""
    return hashlib.sha256(source_url.encode()).hexdigest()[:DIGEST_CHARS]


def find_page(conn, doi: str = "", arxiv_id: str = "", urls: tuple = ()) -> dict | None:
    """Lookup BY ATTACHMENT: the page whose PDF attachment is this paper, by
    DOI, arXiv id, or any of its URLs — only pages carrying a ``doc_id`` are
    candidates (a clip dedups against files, not titles). Identifier matches
    come from the metadata cache (properties.meta) and the source URL; URL
    matches from the proxy-cache hash, the stored source_url, or the web page
    the extension saved it from (web_url)."""
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
        if doi and (str(meta.get("doi") or "").lower() == doi or doi in src.lower()
                    or norm_doi(web) == doi):
            return block_to_dict(row)
        if arxiv_id and (str(meta.get("arxiv_id") or "").split("v")[0] == arxiv_id
                         or norm_arxiv(src) == arxiv_id or norm_arxiv(web) == arxiv_id):
            return block_to_dict(row)
    return None


def find_web_page(conn, url: str) -> dict | None:
    """The page a web clip (no PDF) made from ``url`` — a root page whose
    ``web_url`` is that URL and that carries no attachment. Pages WITH a PDF
    are find_page's business (they dedup by identifier too)."""
    url = (url or "").strip()
    if not url:
        return None
    for row in conn.execute(
            f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE parent_id = 'root' "
            "AND json_extract(properties, '$.web_url') = ?", (url,)).fetchall():
        props = json.loads(row[4] or "{}")
        if not page_attachment(props):
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
        result = apply_ops(conn, block["id"], [{"op": "set", "id": block["id"],
                                                "props": props_patch(block.get("properties") or {}, props)}],
                           actor=block.get("_actor") or "")
        if block.get("_ws"):
            after_commit(block["_ws"], conn, result)
        block = {**block, "properties": props}
    return block


def _start_metadata(ws: str, actor: str, block_id: str, doi: str = "", arxiv_id: str = "") -> None:
    """Metadata lookup off the request: arXiv → DOI → AI fallback can take
    seconds to minutes and the extension only needs the page id back. The
    detector's doi/arxiv_id ride along as trusted hints — they come from the
    publisher page's own meta tags, exactly what the lookup wants."""
    def run():
        try:
            fetch_page_metadata(ws, block_id, actor, doi=doi, arxiv_id=arxiv_id)
        except HTTPException as e:
            log.info(f"[clip] metadata for {block_id}: {e.detail}")
        except Exception as e:  # a failed lookup must not take the thread down noisily
            log.warning(f"[clip] metadata for {block_id} failed: {e}")
    threading.Thread(target=run, name=f"clip-meta-{block_id}", daemon=True).start()


def _clean_title(title: str) -> str:
    return re.sub(r"\s+", " ", (title or "").replace("\x00", "")).strip()[:500]


def _web_title(url: str) -> str:
    """Automatic title for a web clip without a tab title: the URL's file
    name (last path segment), else its host, else "Untitled" (create_page's
    default)."""
    return url_filename(url) or urllib.parse.urlsplit((url or "").strip()).netloc


def _quote_content(text: str, source_url: str, title: str) -> str:
    """A clipped selection as a block: a markdown quote plus a source line."""
    text = (text or "").replace("\r\n", "\n").strip()[:20_000]
    quote = "\n".join(f"> {line}" if line.strip() else ">" for line in text.split("\n"))
    src = (source_url or "").strip()
    label = _clean_title(title)[:200] or src
    return quote + (f"\n— [{label}]({src})" if src else "")


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
    selection: str = ""           # selected text on the tab; a web clip's first block
    folder: str = ""
    labels: list[str] = []
    allow_oa: bool = True         # substitute an open-access copy behind paywalls
    save_copy: bool = True        # store the PDF server-side (else proxy on open)
    fetch_metadata: bool = True


def _clip_web_page(ws: str, actor: str, conn, payload: ClipRequest, source_url: str, title: str,
                   labels: list[str], doi: str, arxiv_id: str, reason: str) -> dict:
    """The no-PDF outcome of a clip: a page carrying the tab as
    ``properties.web_url`` (title from the tab, else the URL), the clipped
    selection as its first block. Re-clipping the same URL finds that page
    (``find_web_page``) and only files it / appends the new selection."""
    now = page_now()
    existing = find_web_page(conn, source_url)
    if existing:
        block = _apply_tags(conn, {**existing, "_ws": ws, "_actor": actor}, payload.folder, labels)
        if (payload.selection or "").strip():
            after_commit(ws, conn, apply_ops(conn, block["id"], [{
                "op": "insert", "id": secrets.token_urlsafe(9), "parent": block["id"],
                "content": _quote_content(payload.selection, source_url, title)}], actor=actor))
        return _result(block, existed=True)
    props = {"web_url": source_url} if source_url else {}
    block = create_page(conn, title or _web_title(source_url), props)
    if (payload.selection or "").strip():
        _insert_last(conn, block["id"], _quote_content(payload.selection, source_url, title), {}, now)
        conn.commit()
    block = _apply_tags(conn, block, payload.folder, labels)
    # A DOI/arXiv id found on the page still identifies the work — the
    # lookup needs no PDF for those, so the note can cite even without one.
    if payload.fetch_metadata and (doi or arxiv_id):
        _start_metadata(ws, actor, block["id"], doi=doi, arxiv_id=arxiv_id)
    note = "No PDF found — saved as a page with its web source"
    return _result(block, existed=False, note=f"{note} ({reason})." if reason else note + ".")


# Sync on purpose: resolving and downloading run in FastAPI's threadpool.
@router.post("/clip")
def clip(payload: ClipRequest, request: Request):
    ws = require_ws(request, write=True)
    actor = request.state.user or ""
    source_url = (payload.source_url or "").strip()
    pdf_url = (payload.pdf_url or "").strip()
    doi = norm_doi(payload.doi) or norm_doi(pdf_url) or norm_doi(source_url)
    arxiv_id = norm_arxiv(payload.arxiv_id) or norm_arxiv(pdf_url) or norm_arxiv(source_url)
    title = _clean_title(payload.title)
    labels = [str(label) for label in (payload.labels or [])][:50]
    note = ""

    # 1. Dedup by identifier — the same paper reached via abs / pdf / DOI
    #    URLs hashes to different doc ids, so URL equality isn't enough.
    with connect_pages_db(ws) as conn:
        existing = find_page(conn, doi, arxiv_id, (pdf_url, source_url))
        if existing:
            block = _apply_tags(conn, existing, payload.folder, labels)
            return _result(block, existed=True)

    if not (payload.doc_id or pdf_url or arxiv_id or doi):
        # Nothing points at a PDF: a plain web page. No resolver round-trip —
        # its HTML would never pass the PDF check anyway.
        if not (source_url or title or (payload.selection or "").strip()):
            raise HTTPException(status_code=400, detail="nothing to save: no URL, title or selection")
        with connect_pages_db(ws) as conn:
            return _clip_web_page(ws, actor, conn, payload, source_url, title, labels, doi, arxiv_id, "")

    if payload.doc_id:
        # 2a. The extension uploaded the bytes itself (its browser session got
        #     past a paywall the server can't). The file must already exist.
        try:
            doc_id = safe_doc_id(payload.doc_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid doc_id")
        if not (ws_uploads_dir(ws) / f"{doc_id}.pdf").is_file():
            raise HTTPException(status_code=404, detail="no uploaded PDF with this doc_id — upload it first")
        page_source = f"/api/uploads/{doc_id}.pdf"
    else:
        # 2b. Resolve the best identifier to a fetchable PDF URL, then make
        #     sure it really delivers a PDF before any PDF page exists. A
        #     dead link never leaves a page with a broken attachment behind
        #     (same rule as openPdf) — the clip becomes a web-source page
        #     instead, so nothing the user asked to keep is lost.
        candidate = pdf_url or arxiv_id or doi or source_url
        try:
            resolved = resolve_source(candidate, payload.allow_oa)
            page_source = resolved["source_url"]
            note = resolved.get("note", "")
            doc_id = url_doc_id(page_source)
            local = ws_uploads_dir(ws) / f"{doc_id}.pdf"
            if not local.is_file():
                _, data = download_pdf(page_source, want_bytes=payload.save_copy)
                if payload.save_copy:
                    if can_store(ws, len(data)):
                        local.parent.mkdir(parents=True, exist_ok=True)
                        local.write_bytes(data)
                    else:
                        log.info(f"[clip] not caching {doc_id} ({len(data)} bytes): over storage limits")
                        note = (note + " " if note else "") + \
                            "Not stored: over your storage limit — the PDF is proxied on open."
        except HTTPException as e:
            if e.status_code != 400 or not (source_url or title):
                raise
            log.info(f"[clip] no PDF for {candidate}: {e.detail} — saving as a web page")
            with connect_pages_db(ws) as conn:
                return _clip_web_page(ws, actor, conn, payload, source_url, title, labels,
                                      doi, arxiv_id, str(e.detail))

    # 3. The page, filed and tagged.
    with connect_pages_db(ws) as conn:
        # No tab title: the page is named after the URL's file name, else the
        # doc id (attachment_props), marked auto_title for the metadata lookup.
        block = get_or_create_doc_page(conn, doc_id, title, page_source)
        props = dict(block.get("properties") or {})
        if source_url and not props.get("web_url") and source_url != page_source:
            props["web_url"] = source_url
            after_commit(ws, conn, apply_ops(conn, block["id"], [
                {"op": "set", "id": block["id"], "props": {"web_url": source_url}}], actor=actor))
            block = {**block, "properties": props}
        block = _apply_tags(conn, {**block, "_ws": ws, "_actor": actor}, payload.folder, labels)

    # 4. Metadata, off the request.
    if payload.fetch_metadata and not (block.get("properties") or {}).get("meta"):
        _start_metadata(ws, actor, block["id"], doi=doi, arxiv_id=arxiv_id)
    return _result(block, existed=False, note=note)


@router.get("/library/lookup")
def library_lookup(request: Request, doi: str = "", arxiv_id: str = "", url: str = ""):
    """Is this paper already in the library? 404 when not."""
    ws = require_ws(request)
    url = (url or "").strip()
    doi = norm_doi(doi) or norm_doi(url)
    arxiv_id = norm_arxiv(arxiv_id) or norm_arxiv(url)
    if not (doi or arxiv_id or url):
        raise HTTPException(status_code=400, detail="doi, arxiv_id, or url required")
    with connect_pages_db(ws) as conn:
        block = find_page(conn, doi, arxiv_id, (url,)) or find_web_page(conn, url)
    if not block:
        raise HTTPException(status_code=404, detail="not in library")
    return _result(block, existed=True)


# Registry records are public and slow (doi.org / arXiv round trips); the
# popup asks about the same tab on every open, so remember recent answers.
@router.get("/library/preview")
def library_preview(request: Request, doi: str = "", arxiv_id: str = "", url: str = ""):
    """What paper is this identifier? The registry record (title, authors,
    year, venue) for the popup to show before anything is saved — a PDF tab
    has no meta tags to read a title from. 404 when the registry has nothing."""
    require_user(request)
    url = (url or "").strip()
    doi = norm_doi(doi) or norm_doi(url)
    arxiv_id = norm_arxiv(arxiv_id) or norm_arxiv(url)
    if not (doi or arxiv_id):
        raise HTTPException(status_code=400, detail="doi or arxiv_id required")
    meta = registry_record(doi, arxiv_id)
    if not meta:
        raise HTTPException(status_code=404, detail="no registry record")
    return {k: meta.get(k) or ("" if k != "authors" else []) for k in
            ("title", "authors", "year", "venue", "doi", "arxiv_id", "source")}


@router.get("/library/folders")
def library_folders(request: Request):
    """Folder paths (with their ancestors) and flat labels in use — the
    popup's pickers, without pulling every page down."""
    ws = require_ws(request)
    folders: set[str] = set()
    labels: set[str] = set()
    with connect_pages_db(ws) as conn:
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
    ws = require_ws(request, write=True)
    if not (payload.text or "").strip():
        raise HTTPException(status_code=400, detail="nothing selected")
    content = _quote_content(payload.text, payload.source_url, payload.title)
    now = page_now()
    with connect_pages_db(ws) as conn:
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
        block_id = secrets.token_urlsafe(9)
        after_commit(ws, conn, apply_ops(conn, page_id, [
            {"op": "insert", "id": block_id, "parent": page_id, "content": content}],
            actor=request.state.user or ""))
    return {"block_id": block_id, "page_id": page_id,
            "open_url": f"/?block={urllib.parse.quote(block_id)}"}
