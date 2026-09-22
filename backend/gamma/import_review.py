"""Shared, JSON-safe import review and selection helpers.

Selection IDs name source records, never destination database IDs. Omitting
selection preserves the full-import API; an explicit empty list imports nothing.
"""
import json

from fastapi import HTTPException


def parse_selection(raw: str | None) -> set[str] | None:
    if raw is None:
        return None
    try:
        values = json.loads(raw)
    except (TypeError, ValueError):
        values = None
    if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
        raise HTTPException(status_code=400, detail="selection must be a JSON list of import item IDs")
    return set(values)


def validate_selection(selected, available):
    if selected is not None and selected - set(available):
        raise HTTPException(status_code=400, detail="selection contains unknown import items; review the file again")


def archive_entries(zf):
    return [{"path": zi.filename.replace("\\", "/"), "size": zi.file_size,
             "directory": zi.is_dir(), "status": "source"} for zi in zf.infolist()]


def selected_warnings(warnings, selected):
    return [w for w in warnings if selected is None or not w.get("selection_id") or w["selection_id"] in selected]
