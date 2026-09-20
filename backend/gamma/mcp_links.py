"""Resolve Gamma links locally within the authenticated MCP workspace.

A pasted URL is an identifier, never a fetch target or an additional grant.
"""

from urllib.parse import parse_qs, urlencode, urlsplit

from .blocks_store import page_root_id
from .db import connect_pages_db, connect_users_db

LINK_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"url": {"type": "string", "minLength": 1, "maxLength": 8192,
                           "description": "A Gamma page, block, or share URL, optionally with pdf_page and quote."}},
    "required": ["url"],
}


def _origin(url):
    host = (url.hostname or "").lower()
    if host in {"localhost", "127.0.0.1", "::1"}:
        host = "localhost"
    return url.scheme.lower(), host, url.port if url.port is not None else (443 if url.scheme == "https" else 80)


def resolve_link(ws: str, base: str, url: str) -> dict:
    """Return a validated reference; caller reads it through the usual dispatcher."""
    try:
        if not isinstance(url, str) or not url or len(url) > 8192 or any(ord(c) < 32 for c in url):
            raise ValueError
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise ValueError
        same_origin = _origin(parsed) == _origin(urlsplit(base))
        if parsed.path not in {"", "/"}:
            raise ValueError
        params = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=30)
        keys = ("ws", "page", "block", "share", "pdf_page", "quote")
        if any(len(params.get(key, [])) > 1 for key in keys):
            raise ValueError
        values = {key: params[key][0] for key in keys if key in params}
        if any(not value or len(value) > (4000 if key == "quote" else 128) for key, value in values.items()):
            raise ValueError
    except ValueError:
        raise ValueError("Use a valid Gamma page, block, or share URL.") from None
    if not same_origin:
        raise ValueError("This link belongs to a different Gamma server. Use its MCP connection or copy a link from this server.")
    if values.get("ws", ws) != ws:
        raise ValueError("This link is outside the connected workspace. Connect the page's workspace first.")
    page_id, block_id = values.get("page"), values.get("block")
    if values.get("share"):
        # Resolve only in the granted workspace, including restricted shares.
        # The integration already has workspace access; share audience adds none.
        with connect_users_db() as conn:
            row = conn.execute("SELECT page_id FROM shares WHERE token = ? AND workspace_id = ?",
                               (values["share"], ws)).fetchone()
        if not row:
            raise ValueError("This share link is unavailable in the connected workspace.")
        if page_id and page_id != row[0]:
            raise ValueError("The page and share link refer to different pages.")
        page_id = row[0]
    pdf_page = None
    if "pdf_page" in values:
        raw = values["pdf_page"]
        if not raw.isascii() or not raw.isdecimal() or not 1 <= int(raw) <= 1_000_000:
            raise ValueError("pdf_page must be a positive PDF page number.")
        pdf_page = int(raw)
    with connect_pages_db(ws) as conn:
        if block_id:
            root = page_root_id(conn, block_id)
            if not root or (page_id and page_id != root):
                raise ValueError("The linked block is unavailable on this page in the connected workspace.")
            page_id = root
        row = conn.execute("SELECT content FROM unified_blocks WHERE id = ? AND parent_id = 'root'",
                           (page_id,)).fetchone() if page_id else None
    if not row:
        raise ValueError("The linked page is unavailable in the connected workspace.")
    canonical = {"ws": ws, "page": page_id}
    if block_id:
        canonical["block"] = block_id
    if pdf_page:
        canonical["pdf_page"] = pdf_page
    reference = {"workspace_id": ws, "page_id": page_id, "title": row[0] or "Untitled",
                 "url": base + "/?" + urlencode(canonical)}
    if block_id:
        reference["block_id"] = block_id
    if pdf_page:
        reference["pdf_page"] = pdf_page
    if values.get("quote"):
        reference["selected_quote"] = values["quote"]
    return reference
