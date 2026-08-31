"""Markdown export: a page (or a folder of pages) as .md, or .zip when the
page references uploaded assets (Notion-style: bare file vs. bundle decided by
whether there's anything to bundle)."""

import os
import re
import sqlite3
import tempfile
import zipfile
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from ..auth import require_user, resolve_user, share_scope_doc
from ..blocks_store import BLOCK_COLUMNS, assert_block_in_doc, block_to_dict, fetch_subtree
from ..db import pdf_upload_path, safe_doc_id, user_db_path, user_uploads_dir
from ..logbuf import log
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
from ..pdf_export import annotate_pdf, highlight_note_text, zotero_annot_key
from ..pdf_notes import render_notes
from ..zotero_export import build_rdf, note_html

router = APIRouter(prefix="/api", tags=["export"])

_ZOTERO_MAX_PAGES = 500
_ZOTERO_MAX_BLOCKS = 100_000
_ZOTERO_MAX_PDF_BYTES = 128 * 1024 * 1024
_ZOTERO_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
_ZOTERO_MAX_RDF_BYTES = 16 * 1024 * 1024
_EXPORT_MODES = {"readable", "logseq-graph", "zotero-rdf"}


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
    pdf_path = None
    if doc_id:
        try:
            pdf_path = uploads_dir / f"{safe_doc_id(doc_id)}.pdf"
        except ValueError:
            pdf_path = None
    has_pdf = bool(include_pdf and pdf_path and pdf_path.is_file())

    md, assets = collect_and_rewrite(render_graph_page_md(page, stem, has_pdf), include_pdf=False, prefix="../assets/")
    entries = [(f"pages/{stem}.md", md)]
    files, blobs = [], []
    if has_pdf:
        highlights = collect_highlights(page)
        entries.append((f"pages/hls__{stem}.md", render_hls_md(stem, highlights)))
        entries.append((f"assets/{stem}.edn", render_edn(highlights)))
        files.append((f"assets/{stem}.pdf", pdf_path))
        blobs.extend(render_area_images(pdf_path, stem, highlights))
    return entries, files, blobs, assets


def _check_export_mode(mode: str):
    if mode not in _EXPORT_MODES:
        raise HTTPException(status_code=400, detail="unsupported export mode")


def _collect_marks(blocks) -> list[dict]:
    """Convert stored highlight blocks to safe PDF annotation marks."""
    children_by_id: dict = {}
    for block in sorted(blocks, key=lambda item: item["position"] or ""):
        children_by_id.setdefault(block["parent_id"], []).append(block)

    marks = []
    for block in blocks:
        props = block["properties"]
        if not props.get("highlight_id") or not props.get("pdf_position"):
            continue
        if props.get("imported_annot") and not props.get("annot_stripped"):
            continue
        if props.get("link_url") or props.get("link_page_id"):
            continue
        marks.append({
            "position": props["pdf_position"],
            "color": props.get("color"),
            "note": highlight_note_text(block, children_by_id),
            "id": props["highlight_id"],
        })
    return marks


def _zotero_export_parts(conn, user: str, roots: list[dict], base: str,
                          folder_scope: str | None, include_taxonomy: bool,
                          include_pdf: bool, highlights: bool, notes: bool):
    """Build bounded Zotero RDF entries and local/annotated PDF payloads."""
    if len(roots) > _ZOTERO_MAX_PAGES:
        raise HTTPException(status_code=413, detail="too many pages for Zotero export")

    items, files, blobs = [], [], []
    output_bytes = 0
    block_count = 0
    for number, root in enumerate(roots, 1):
        rows = fetch_subtree(conn, root["id"])
        block_count += len(rows)
        if block_count > _ZOTERO_MAX_BLOCKS:
            raise HTTPException(status_code=413, detail="too many blocks for Zotero export")
        page = build_tree(rows, root["id"])
        props = page.get("properties") or {}
        meta = props.get("meta") if isinstance(props.get("meta"), dict) else {}
        title = re.sub(r"\s+", " ", page.get("content") or "").strip() or "Untitled"

        pdf_arc = None
        doc_id = props.get("doc_id")
        if include_pdf and doc_id:
            try:
                pdf_path = pdf_upload_path(user, doc_id)
            except ValueError:
                log.warning("[zotero-export] skipping invalid document id on page %s", root["id"])
                pdf_path = None
            if pdf_path and pdf_path.is_file():
                size = pdf_path.stat().st_size
                if size > _ZOTERO_MAX_PDF_BYTES:
                    raise HTTPException(status_code=413, detail="PDF too large for Zotero export")
                pdf_leaf = slugify(title, "")
                if pdf_leaf in {"", ".", ".."}:
                    pdf_leaf = "paper"
                pdf_arc = f"files/{number}/{pdf_leaf}.pdf"
                marks = _collect_marks([block_to_dict(row) for row in rows]) if highlights else []
                if marks:
                    try:
                        data, _ = annotate_pdf(pdf_path.read_bytes(), marks, author=user)
                    except Exception as error:
                        log.warning(
                            "[zotero-export] annotation failed for page %s; using bare PDF: %s",
                            root["id"],
                            error,
                        )
                        output_bytes += size
                        files.append((f"{base}/{pdf_arc}", pdf_path))
                    else:
                        output_bytes += len(data)
                        blobs.append((f"{base}/{pdf_arc}", data))
                else:
                    output_bytes += size
                    files.append((f"{base}/{pdf_arc}", pdf_path))
                if output_bytes > _ZOTERO_MAX_ARCHIVE_BYTES:
                    raise HTTPException(status_code=413, detail="Zotero export is too large")

        memo_html = []
        if notes:
            for child in page.get("children") or []:
                child_props = child.get("properties") or {}
                if child_props.get("highlight_id") or child_props.get("link_url"):
                    continue
                html = note_html(child)
                if html:
                    memo_html.append({
                        "key": child_props.get("zotero_note")
                               or f"#gamma_note_{zotero_annot_key(child['id'])}",
                        "html": html,
                    })

        folders = []
        if include_taxonomy:
            folders = [path.strip() for path in (props.get("folder") or "").split(",") if path.strip()]
            if folder_scope:
                folders = [
                    path for path in folders
                    if path == folder_scope or path.startswith(folder_scope + "/")
                ]
        arxiv = str(meta.get("arxiv_id") or "").strip()
        items.append({
            "key": props.get("zotero_key")
                   or (f"https://arxiv.org/abs/{arxiv}" if arxiv
                       else f"#gamma_item_{zotero_annot_key(root['id'])}"),
            "title": title,
            "meta": meta,
            "tags": ([tag.strip() for tag in (props.get("category") or "").split(",") if tag.strip()]
                     if include_taxonomy else []),
            "folders": folders,
            "pdf_path": pdf_arc,
            "notes": memo_html,
        })

    rdf = build_rdf(items)
    if len(rdf.encode("utf-8")) > _ZOTERO_MAX_RDF_BYTES:
        raise HTTPException(status_code=413, detail="Zotero metadata is too large")
    readme = (
        "Import into Zotero\n"
        "==================\n\n"
        f"1. Extract this zip and keep {base}.rdf and files/ together.\n"
        f"2. In Zotero choose File -> Import... -> A file, then select {base}.rdf.\n\n"
        "Do not select the zip itself; Zotero imports the extracted RDF file.\n"
    )
    entries = [(f"{base}/{base}.rdf", rdf), (f"{base}/README.txt", readme)]
    return entries, files, blobs


# Sync on purpose: rendering + zipping runs in FastAPI's threadpool.
@router.get("/pages/{block_id}/export")
def export_page(block_id: str, request: Request, mode: str = "readable", pdf: int = 1,
                highlights: int = 1, notes: int = 1):
    """One page → readable Markdown: bare .md when it references no local
    assets, else a .zip of the .md plus an assets/ folder. ``highlights=0`` /
    ``notes=0`` (the export dialog's switches) leave out the quoted PDF text or
    your own writing. ``mode=logseq-graph`` instead returns a complete Logseq
    file graph (pages/ + assets/ + logseq/config.edn, highlights as native
    hls__ page + EDN) — openable by file-based Logseq directly and convertible
    by the DB version's "File to DB graph" importer; a graph is defined by both
    layers, so the two switches don't apply to it. ``mode=zotero-rdf`` returns
    a one-page Zotero RDF library archive."""
    _check_export_mode(mode)
    user = resolve_user(request)
    scope = share_scope_doc(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        assert_block_in_doc(conn, block_id, scope)
        rows = fetch_subtree(conn, block_id)
    if not rows:
        raise HTTPException(status_code=404, detail="page not found")

    page = build_tree(rows, block_id)
    slug = slugify(page.get("content"), block_id)

    if mode == "zotero-rdf":
        with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
            entries, files, blobs = _zotero_export_parts(
                conn,
                user,
                [{"id": block_id}],
                slug,
                None,
                include_taxonomy=scope is None,
                include_pdf=bool(pdf),
                highlights=bool(highlights),
                notes=bool(notes),
            )
        return _zip_response(
            entries,
            set(),
            user_uploads_dir(user),
            f"{slug}-zotero.zip",
            files=files,
            blobs=blobs,
        )

    if mode == "logseq-graph":
        entries, files, blobs, assets = _graph_page_parts(page, user_uploads_dir(user), bool(pdf))
        entries.append(("logseq/config.edn", CONFIG_EDN))
        return _zip_response(entries, assets, user_uploads_dir(user), f"{slug}-logseq.zip", files, blobs)

    md, assets = collect_and_rewrite(
        render_readable(page, highlights=bool(highlights), notes=bool(notes)),
        include_pdf=bool(pdf))
    if not assets:
        return _md_response(md, slug)
    return _zip_response([(f"{slug}.md", md)], assets, user_uploads_dir(user), f"{slug}.zip")


# Sync on purpose: PyPDF2 rewriting is CPU-bound; the threadpool keeps the loop free.
@router.get("/pages/{block_id}/export-pdf")
def export_page_pdf(block_id: str, request: Request, notes: int = 0, highlights: int = 1):
    """The page's PDF with its highlights burned in as standard /Highlight
    annotations (notes become the annotation popup text), so they survive in
    any external PDF viewer. ``notes=1`` additionally paints every non-empty
    note onto the page itself, in the nearest free space with a leader line
    back to its highlight — readable without opening popups, and printable.
    ``highlights=0`` skips the annotation layer, so ``highlights=0&notes=1``
    gives a clean PDF carrying only the written notes."""
    user = resolve_user(request)
    scope = share_scope_doc(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        assert_block_in_doc(conn, block_id, scope)
        rows = fetch_subtree(conn, block_id)
    if not rows:
        raise HTTPException(status_code=404, detail="page not found")
    blocks = [block_to_dict(r) for r in rows]
    root = next(b for b in blocks if b["id"] == block_id)
    doc_id = root["properties"].get("doc_id")
    if not doc_id:
        raise HTTPException(status_code=400, detail="page has no PDF")
    try:
        pdf_path = pdf_upload_path(user, doc_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid document id")
    if not pdf_path.is_file():
        raise HTTPException(status_code=404, detail="PDF not stored on the server")

    marks = _collect_marks(blocks)

    written = 0
    pdf_bytes = pdf_path.read_bytes()
    if highlights:
        try:
            pdf_bytes, written = annotate_pdf(pdf_bytes, marks, author=user)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"could not annotate PDF: {e}")

    drawn = 0
    if notes:
        # Still positioned from the highlight rects, annotation layer or not.
        try:
            pdf_bytes, drawn = render_notes(pdf_bytes, marks,
                                            uploads_dir=user_uploads_dir(user))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"could not render notes: {e}")

    slug = slugify(root.get("content"), block_id)
    suffix = "-notes" if notes else "-annotated" if highlights else ""
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": _content_disposition(f"{slug}{suffix}.pdf"),
            "X-Annotations-Written": str(written),
            "X-Notes-Rendered": str(drawn),
        },
    )


def _page_in_folder(props: dict, name: str) -> bool:
    raw = props.get("folder") or ""
    for path in (p.strip() for p in raw.split(",")):
        if path and (path == name or path.startswith(name + "/")):
            return True
    return False


@router.get("/folders/export")
def export_folder(request: Request, name: str, mode: str = "readable", pdf: int = 1,
                  highlights: int = 1, notes: int = 1):
    """Export one authenticated owner's folder and descendants as an archive."""
    _check_export_mode(mode)
    name = (name or "").strip().strip("/")
    if not name:
        raise HTTPException(status_code=400, detail="folder name required")
    # Folder exports are owner-only; a public share is scoped to one page.
    if share_scope_doc(request) is not None:
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    user = require_user(request)
    folder_slug = slugify(name.replace("/", "-"), "")
    if folder_slug in {"", ".", ".."}:
        raise HTTPException(status_code=400, detail="invalid folder name for export")
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        roots = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE parent_id = 'root'").fetchall()
        matches = [block_to_dict(r) for r in roots]
        matches = [b for b in matches if _page_in_folder(b["properties"], name)]
        if not matches:
            raise HTTPException(status_code=404, detail="no pages in that folder")

        if mode == "zotero-rdf":
            entries, files, blobs = _zotero_export_parts(
                conn,
                user,
                matches,
                folder_slug,
                name,
                include_taxonomy=True,
                include_pdf=bool(pdf),
                highlights=bool(highlights),
                notes=bool(notes),
            )
            return _zip_response(
                entries,
                set(),
                user_uploads_dir(user),
                f"{folder_slug}-zotero.zip",
                files=files,
                blobs=blobs,
            )

        entries, assets, used = [], set(), set()
        files, blobs = [], []
        for root in matches:
            rows = fetch_subtree(conn, root["id"])
            page = build_tree(rows, root["id"])
            if mode == "logseq-graph":
                p_entries, p_files, p_blobs, p_assets = _graph_page_parts(page, user_uploads_dir(user), bool(pdf))
                entries += p_entries
                files += p_files
                blobs += p_blobs
                assets |= p_assets
                continue
            md, page_assets = collect_and_rewrite(
                render_readable(page, highlights=bool(highlights), notes=bool(notes)),
                include_pdf=bool(pdf),
            )
            assets |= page_assets
            slug = slugify(page.get("content"), root["id"])
            arcname = f"{slug}.md"
            # id suffix makes collisions near-impossible, but guard anyway.
            while arcname in used:
                arcname = f"{slug}-{len(used)}.md"
            used.add(arcname)
            entries.append((arcname, md))

    if mode == "logseq-graph":
        entries.append(("logseq/config.edn", CONFIG_EDN))
        return _zip_response(entries, assets, user_uploads_dir(user), f"{folder_slug}-logseq.zip", files, blobs)
    return _zip_response(entries, assets, user_uploads_dir(user), f"{folder_slug}.zip")
