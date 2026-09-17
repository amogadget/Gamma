"""Workspace-bound metadata for the optional MCP Apps paper picker."""

import json
import base64
from pathlib import Path
from urllib.parse import urlencode

from .blocks_store import page_attachment
from .db import connect_pages_db
from .workspaces import get

PICKER_URI = "ui://gamma/paper-picker-v1.html"
PICKER_MIME = "text/html;profile=mcp-app"
PAGE_SIZE = 20
ICON_URI = "data:image/png;base64," + base64.b64encode(Path(__file__).with_name("mcp_icon.png").read_bytes()).decode("ascii")
PICKER_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "query": {"type": "string", "maxLength": 200, "description": "Case-insensitive paper/page title substring."},
        "offset": {"type": "integer", "minimum": 0, "maximum": 1000000},
    },
}


def picker_html():
    return Path(__file__).with_name("mcp_paper_picker.html").read_text(encoding="utf-8").replace("__GAMMA_ICON__", ICON_URI)


def paper_choices(ws: str, base: str, args: dict) -> dict:
    # ws comes only from the authenticated integration token, never tool args.
    query = args.get("query", "").strip()
    offset = args.get("offset", 0)
    pages, total = [], 0
    with connect_pages_db(ws) as conn:
        for page_id, title, raw in conn.execute(
                "SELECT id, content, properties FROM unified_blocks WHERE parent_id = 'root' "
                "ORDER BY updated_at DESC, id"):
            title = title or "Untitled"
            if query.casefold() not in title.casefold():
                continue
            total += 1
            if not offset < total <= offset + PAGE_SIZE:
                continue
            try:
                props = json.loads(raw or "{}")
            except (TypeError, ValueError):
                props = {}
            attachment = page_attachment(props if isinstance(props, dict) else {})
            pages.append({"id": page_id, "title": title[:300], "kind": "PDF" if attachment else "Notes",
                          "url": base + "/?" + urlencode({"ws": ws, "page": page_id})})
    workspace = get(ws)
    return {"pages": pages, "workspace": {"id": ws, "name": workspace["name"] if workspace else ws},
            "query": query, "offset": offset, "total": total,
            "next_offset": offset + PAGE_SIZE if offset + PAGE_SIZE < total else None}
