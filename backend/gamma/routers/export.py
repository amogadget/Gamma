"""Markdown export: a page (or a folder of pages) as .md, or .zip when the
page references uploaded assets (Notion-style: bare file vs. bundle decided by
whether there's anything to bundle)."""

import os
import sqlite3
import tempfile
import zipfile
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from ..auth import resolve_user
from ..blocks_store import BLOCK_COLUMNS, block_to_dict, fetch_subtree
from ..db import user_db_path, user_uploads_dir
from ..logseq_graph_export import (
    CONFIG_EDN,
    collect_highlights,
    render_area_images,
    render_edn,
    render_graph_page_md,
    render_hls_md,
)
from ..markdown_export import (
    build_tree,
    collect_and_rewrite,
    render_readable,
    slugify,
)
from ..pdf_export import annotate_pdf, highlight_note_text

router = APIRouter(prefix="/api", tags=["export"])


def _content_disposition(filename: str) -> str:
    """attachment header carrying both an ASCII fallback and a UTF-8 name."""
    ascii_name = filename.encode("ascii", "ignore").decode() or "export"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def _md_response(md: str, slug: str) -> Response:
    return Response(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": _content_disposition(f"{slug}.md")},
    )


def _zip_response(entries, assets, uploads_dir, download_name: str, files=(), blobs=()) -> FileResponse:
    """entries: list of (arcname, text). assets: set of upload filenames, written
    once under assets/ (deduped by content-addressed name). files: (arcname,
    disk path) pairs; blobs: (arcname, bytes) pairs."""
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
            for arcname, text in entries:
                z.writestr(arcname, text)
            for filename in sorted(assets):
                path = uploads_dir / filename
                if path.is_file():
                    z.write(path, f"assets/{filename}")
            for arcname, path in files:
                if path.is_file():
                    z.write(path, arcname)
            for arcname, data in blobs:
                z.writestr(arcname, data)
    except Exception:
        os.unlink(tmp.name)
        raise
    return FileResponse(
        tmp.name,
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(download_name)},
        background=BackgroundTask(os.unlink, tmp.name),
    )


def _graph_page_parts(page, uploads_dir, include_pdf):
    """One page in Logseq file-graph layout → (text entries, disk files,
    blobs, image-asset names). The PDF is renamed sha → page stem so the
    ``hls__<stem>`` page / ``<stem>.edn`` / ``<stem>.pdf`` naming convention
    Logseq's annotation system keys on actually holds. Spaces are replaced so
    inline ``![](../assets/<stem>.pdf)`` links stay valid Markdown."""
    stem = slugify(page.get("content"), page["id"]).replace(" ", "_")
    doc_id = (page.get("properties") or {}).get("doc_id")
    pdf_path = uploads_dir / f"{doc_id}.pdf" if doc_id else None
    has_pdf = bool(include_pdf and pdf_path and pdf_path.is_file())

    md, assets = collect_and_rewrite(
        render_graph_page_md(page, stem, has_pdf), include_pdf=False, prefix="../assets/"
    )
    entries = [(f"pages/{stem}.md", md)]
    files, blobs = [], []
    if has_pdf:
        highlights = collect_highlights(page)
        entries.append((f"pages/hls__{stem}.md", render_hls_md(stem, highlights)))
        entries.append((f"assets/{stem}.edn", render_edn(highlights)))
        files.append((f"assets/{stem}.pdf", pdf_path))
        blobs.extend(render_area_images(pdf_path, stem, highlights))
    return entries, files, blobs, assets


# Sync on purpose: rendering + zipping runs in FastAPI's threadpool.
@router.get("/pages/{block_id}/export")
def export_page(block_id: str, request: Request, mode: str = "readable", pdf: int = 1):
    """One page → readable Markdown: bare .md when it references no local
    assets, else a .zip of the .md plus an assets/ folder. ``mode=logseq-graph``
    instead returns a complete Logseq file graph (pages/ + assets/ +
    logseq/config.edn, highlights as native hls__ page + EDN) — openable by
    file-based Logseq directly and convertible by the DB version's "File to DB
    graph" importer."""
    user = resolve_user(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        rows = fetch_subtree(conn, block_id)
    if not rows:
        raise HTTPException(status_code=404, detail="page not found")

    page = build_tree(rows, block_id)
    slug = slugify(page.get("content"), block_id)

    if mode == "logseq-graph":
        entries, files, blobs, assets = _graph_page_parts(page, user_uploads_dir(user), bool(pdf))
        entries.append(("logseq/config.edn", CONFIG_EDN))
        return _zip_response(entries, assets, user_uploads_dir(user),
                             f"{slug}-logseq.zip", files, blobs)

    md, assets = collect_and_rewrite(render_readable(page), include_pdf=bool(pdf))
    if not assets:
        return _md_response(md, slug)
    return _zip_response([(f"{slug}.md", md)], assets, user_uploads_dir(user), f"{slug}.zip")


# Sync on purpose: PyPDF2 rewriting is CPU-bound; the threadpool keeps the loop free.
@router.get("/pages/{block_id}/export-pdf")
def export_page_pdf(block_id: str, request: Request):
    """The page's PDF with its highlights burned in as standard /Highlight
    annotations (notes become the annotation popup text), so they survive in
    any external PDF viewer."""
    user = resolve_user(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        rows = fetch_subtree(conn, block_id)
    if not rows:
        raise HTTPException(status_code=404, detail="page not found")
    blocks = [block_to_dict(r) for r in rows]
    root = next(b for b in blocks if b["id"] == block_id)
    doc_id = root["properties"].get("doc_id")
    if not doc_id:
        raise HTTPException(status_code=400, detail="page has no PDF")
    pdf_path = user_uploads_dir(user) / f"{doc_id}.pdf"
    if not pdf_path.is_file():
        raise HTTPException(status_code=404, detail="PDF not stored on the server")

    children_by_id: dict = {}
    for b in sorted(blocks, key=lambda b: b["position"] or ""):
        children_by_id.setdefault(b["parent_id"], []).append(b)

    highlights = []
    for b in blocks:
        props = b["properties"]
        if not props.get("highlight_id") or not props.get("pdf_position"):
            continue
        # Skip annotations that came from the PDF itself and are STILL embedded
        # in it (annot_stripped marks ones the import removed from the file),
        # and link regions (Gamma navigation aids, not annotations).
        if props.get("imported_annot") and not props.get("annot_stripped"):
            continue
        if props.get("link_url") or props.get("link_page_id"):
            continue
        highlights.append({
            "position": props["pdf_position"],
            "color": props.get("color"),
            "note": highlight_note_text(b, children_by_id),
        })

    try:
        pdf_bytes, written = annotate_pdf(pdf_path.read_bytes(), highlights, author=user)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"could not annotate PDF: {e}")

    slug = slugify(root.get("content"), block_id)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": _content_disposition(f"{slug}-annotated.pdf"),
            "X-Annotations-Written": str(written),
        },
    )


def _page_in_folder(props: dict, name: str) -> bool:
    raw = props.get("folder") or ""
    for path in (p.strip() for p in raw.split(",")):
        if path and (path == name or path.startswith(name + "/")):
            return True
    return False


@router.get("/folders/export")
def export_folder(request: Request, name: str, mode: str = "readable", pdf: int = 1):
    """Every page tagged into folder ``name`` (or a subfolder of it) → a single
    .zip: one .md per page at the root, a shared assets/ folder (deduped)."""
    name = (name or "").strip().strip("/")
    if not name:
        raise HTTPException(status_code=400, detail="folder name required")
    user = resolve_user(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        roots = conn.execute(
            f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE parent_id = 'root'"
        ).fetchall()
        matches = [block_to_dict(r) for r in roots]
        matches = [b for b in matches if _page_in_folder(b["properties"], name)]
        if not matches:
            raise HTTPException(status_code=404, detail="no pages in that folder")

        entries, assets, used = [], set(), set()
        files, blobs = [], []
        for root in matches:
            rows = fetch_subtree(conn, root["id"])
            page = build_tree(rows, root["id"])
            if mode == "logseq-graph":
                p_entries, p_files, p_blobs, p_assets = _graph_page_parts(
                    page, user_uploads_dir(user), bool(pdf))
                entries += p_entries
                files += p_files
                blobs += p_blobs
                assets |= p_assets
                continue
            md, page_assets = collect_and_rewrite(render_readable(page), include_pdf=bool(pdf))
            assets |= page_assets
            slug = slugify(page.get("content"), root["id"])
            arcname = f"{slug}.md"
            # id suffix makes collisions near-impossible, but guard anyway.
            while arcname in used:
                arcname = f"{slug}-{len(used)}.md"
            used.add(arcname)
            entries.append((arcname, md))

    folder_slug = slugify(name.replace("/", "-"), "")
    if mode == "logseq-graph":
        entries.append(("logseq/config.edn", CONFIG_EDN))
        return _zip_response(entries, assets, user_uploads_dir(user),
                             f"{folder_slug}-logseq.zip", files, blobs)
    return _zip_response(entries, assets, user_uploads_dir(user), f"{folder_slug}.zip")
