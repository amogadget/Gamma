"""Per-workspace backups (/api/workspaces/{ws}/backups*): the snapshots
Settings → Backups manages — take one, list, download, restore in place,
delete. The zip and the restore live in gamma/ws_backup.py; this is the
HTTP skin plus who-may-do-what: any member (or admin) lists and downloads,
an owner takes, restores and deletes (a merge restore needs an editor, like
/api/import-data). The guest workspace keeps no snapshots and takes no
restore — it is shared with the whole internet.
"""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import workspaces, ws_backup
from .workspaces import _member

router = APIRouter(prefix="/api/workspaces/{ws}/backups", tags=["backups"])


class BackupCreate(BaseModel):
    label: str = "manual"
    uploads: bool = True


def _not_guest(ws: str) -> None:
    if ws == workspaces.default_workspace("guest"):
        raise HTTPException(status_code=403, detail="the guest workspace keeps no backups")


def _named(ws: str, name: str) -> dict:
    b = ws_backup.info(ws, name)
    if not b:
        raise HTTPException(status_code=404, detail="no such backup")
    return b


@router.get("")
async def list_backups(ws: str, request: Request):
    """``{backups: [{name, size_bytes, created_at, label, uploads,
    upload_files, by}]}``, newest first, plus the per-workspace cap."""
    _member(request, ws, "viewer")
    return {"backups": ws_backup.list_backups(ws), "max": ws_backup.MAX_PER_WORKSPACE}


# Sync def: zipping a library runs in the threadpool.
@router.post("")
def create_backup(ws: str, payload: BackupCreate, request: Request):
    """Take a snapshot now (owner): the databases, plus every upload unless
    ``uploads`` is false."""
    user = _member(request, ws, "owner")
    _not_guest(ws)
    try:
        return ws_backup.create(ws, label=payload.label.strip() or "manual", uploads=payload.uploads, by=user)
    except ws_backup.BackupError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{name}/download")
async def download_backup(ws: str, name: str, request: Request):
    _member(request, ws, "viewer")
    _named(ws, name)
    slug = "".join(c if c.isalnum() else "-" for c in (workspaces.get(ws) or {}).get("name", "")).strip("-")[:40] or ws
    return FileResponse(str(ws_backup.backup_path(ws, name)), media_type="application/zip",
                        filename=f"gamma-backup-{slug}-{name}.zip")


# Sync def: unzip + sqlite restore runs in the threadpool.
@router.post("/{name}/restore")
def restore_backup(ws: str, name: str, request: Request, mode: str = "replace"):
    """Restore the snapshot into its workspace: ``replace`` (owner) swaps the
    databases, ``merge`` (editor) adds what is missing — the same rules as
    /api/import-data."""
    _member(request, ws, "owner" if mode == "replace" else "editor")
    _not_guest(ws)
    _named(ws, name)
    try:
        return {"ok": True, **ws_backup.restore_zip(ws, ws_backup.backup_path(ws, name), mode)}
    except ws_backup.BackupError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{name}")
async def delete_backup(ws: str, name: str, request: Request):
    _member(request, ws, "owner")
    if not ws_backup.delete(ws, name):
        raise HTTPException(status_code=404, detail="no such backup")
    return {"ok": True}
