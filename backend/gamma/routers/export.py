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
from ..markdown_export import (
    build_tree,
    collect_and_rewrite,
    render_page,
    slugify,
)

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


def _zip_response(entries, assets, uploads_dir, download_name: str) -> FileResponse:
    """entries: list of (arcname, text). assets: set of upload filenames, written
    once under assets/ (deduped by content-addressed name)."""
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
    except Exception:
        os.unlink(tmp.name)
        raise
    return FileResponse(
        tmp.name,
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(download_name)},
        background=BackgroundTask(os.unlink, tmp.name),
    )


# Sync on purpose: rendering + zipping runs in FastAPI's threadpool.
@router.get("/pages/{block_id}/export")
def export_page(block_id: str, request: Request, mode: str = "readable", pdf: int = 1):
    """One page → Markdown. Bare .md when it references no local assets, else a
    .zip of the .md plus an assets/ folder."""
    user = resolve_user(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        rows = fetch_subtree(conn, block_id)
    if not rows:
        raise HTTPException(status_code=404, detail="page not found")

    page = build_tree(rows, block_id)
    md, assets = collect_and_rewrite(render_page(page, mode), include_pdf=bool(pdf))
    slug = slugify(page.get("content"), block_id)

    if not assets:
        return _md_response(md, slug)
    return _zip_response([(f"{slug}.md", md)], assets, user_uploads_dir(user), f"{slug}.zip")


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
        for root in matches:
            rows = fetch_subtree(conn, root["id"])
            page = build_tree(rows, root["id"])
            md, page_assets = collect_and_rewrite(render_page(page, mode), include_pdf=bool(pdf))
            assets |= page_assets
            slug = slugify(page.get("content"), root["id"])
            arcname = f"{slug}.md"
            # id suffix makes collisions near-impossible, but guard anyway.
            while arcname in used:
                arcname = f"{slug}-{len(used)}.md"
            used.add(arcname)
            entries.append((arcname, md))

    folder_slug = slugify(name.replace("/", "-"), "")
    return _zip_response(entries, assets, user_uploads_dir(user), f"{folder_slug}.zip")
