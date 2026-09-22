"""unified_blocks table helpers shared across routers."""

import json
import secrets

from fractional_indexing import generate_key_between, generate_n_keys_between

from .db import page_now
from .foldertags import clean_path, parse_tags, path_within
from .storage import display_filename, url_filename

BLOCK_COLUMNS = "id, parent_id, position, content, properties, created_at, updated_at"


def block_to_dict(row) -> dict:
    return {
        "id": row[0],
        "parent_id": row[1],
        "position": row[2],
        "content": row[3] or "",
        "properties": json.loads(row[4] or "{}"),
        "created_at": row[5],
        "updated_at": row[6],
    }


def last_child_position(conn, parent_id: str) -> str | None:
    row = conn.execute(
        "SELECT position FROM unified_blocks WHERE parent_id = ? ORDER BY position DESC LIMIT 1",
        (parent_id,),
    ).fetchone()
    return row[0] if row else None


def fetch_subtree(conn, block_id: str):
    """Fetch a block + all its descendants."""
    return conn.execute(
        f"""
        WITH RECURSIVE subtree AS (
            SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?
            UNION ALL
            SELECT ub.id, ub.parent_id, ub.position, ub.content, ub.properties, ub.created_at, ub.updated_at
            FROM unified_blocks ub JOIN subtree s ON ub.parent_id = s.id
        )
        SELECT {BLOCK_COLUMNS} FROM subtree
        """,
        (block_id,),
    ).fetchall()


def delete_subtree(conn, block_id: str):
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


def delete_children(conn, block_id: str):
    """Delete all descendants of a block, keeping the block itself."""
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


def flatten_tree(tree, parent_id, result, now):
    """Recursively flatten a nested block tree into flat rows with fractional positions."""
    n = len(tree or [])
    if n == 0:
        return
    keys = generate_n_keys_between(None, None, n=n)
    for node, key in zip(tree, keys):
        props = node.get("properties") or {}
        if isinstance(props, str):
            try:
                props = json.loads(props)
            except Exception:
                props = {}
        node_id = node.get("id") or secrets.token_urlsafe(9)
        result.append({
            "id": node_id,
            "parent_id": parent_id,
            "position": key,
            "content": node.get("content", "") or "",
            "properties": json.dumps(props),
            "created_at": node.get("created_at") or now,
            "updated_at": now,
        })
        flatten_tree(node.get("children") or [], node_id, result, now)


def page_root_id(conn, block_id: str) -> str | None:
    """Walk parents up to the top-level page block that contains block_id
    (whose parent is 'root'). Returns the page id, or None if block_id is
    unknown. Cycle-guarded."""
    cur = block_id
    for _ in range(10000):
        row = conn.execute(
            "SELECT parent_id FROM unified_blocks WHERE id = ?", (cur,)
        ).fetchone()
        if not row:
            return None
        parent = row[0]
        if parent in (None, "root"):
            return cur
        cur = parent
    return None


def assert_block_in_page(conn, block_id: str, scope_page_id) -> None:
    """For a share-scoped request (scope_page_id set), raise 403 unless block_id
    is the shared page or lives inside it. No-op for full-access session users
    (scope_page_id is None)."""
    if scope_page_id is None:
        return
    from fastapi import HTTPException

    if page_root_id(conn, block_id) != scope_page_id:
        raise HTTPException(status_code=403, detail="not accessible via this share link")


def ancestor_chains(conn, block_ids: list[str]):
    """Return {block_id: [{id, content}, ...]} ancestor chains (root-first, excluding 'root')
    and {block_id: page_root_id} for a set of blocks, in one recursive CTE."""
    if not block_ids:
        return {}, {}
    placeholders = ",".join("?" * len(block_ids))
    rows = conn.execute(
        f"""
        WITH RECURSIVE chain AS (
            SELECT id AS descendant_id, parent_id, 0 AS depth
            FROM unified_blocks WHERE id IN ({placeholders})
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
        block_ids,
    ).fetchall()
    ancestors_by_id: dict = {}
    page_root_by_id: dict = {}
    for descendant_id, anc_id, anc_content, _depth in rows:
        if anc_id == "root":
            continue  # "root" is a virtual parent, not a real page
        ancestors_by_id.setdefault(descendant_id, []).append({"id": anc_id, "content": anc_content})
        if descendant_id not in page_root_by_id:
            page_root_by_id[descendant_id] = anc_id
    return ancestors_by_id, page_root_by_id


def page_attachment(props: dict | None) -> dict | None:
    """What a page carries: ``{"kind": "pdf", "id": doc_id, "url": source_url,
    "name": original_filename}`` when the page has a PDF attachment (a stored
    ``doc_id`` and/or a ``source_url`` the proxy fetches lazily), else None.

    The ONE place backend code reads ``doc_id``/``source_url`` off a page to
    decide what kind of page it is (gating, labels, listings) — so a later
    ``properties.attachments`` list is a drop-in. Lookups BY attachment
    (``by-doc``, the search index, the PDF export) still key on ``doc_id``
    directly; that is fine, they are about the file, not the page.
    Mirrored by ``pageAttachment()`` in frontend/src/library/libraryUtils.js."""
    props = props or {}
    doc_id = str(props.get("doc_id") or "")
    url = str(props.get("source_url") or "")
    if not doc_id and not url:
        return None
    return {"kind": "pdf", "id": doc_id, "url": url,
            "name": str(props.get("original_filename") or "")}


def page_for_doc(conn, doc_id: str, columns: str = "id"):
    """Lookup BY ATTACHMENT: the row (``columns`` of it) of the root page
    whose PDF attachment is ``doc_id``, or None. The one query for "which
    page carries this PDF" — root pages only, a nested block never counts."""
    if not doc_id:
        return None
    return conn.execute(
        f"SELECT {columns} FROM unified_blocks WHERE parent_id = 'root' "
        "AND json_extract(properties, '$.doc_id') = ? LIMIT 1", (doc_id,)).fetchone()


def root_pages(conn, folder: str = "") -> dict:
    """{page_id: {"title", "doc_id"}} for the root pages a library-wide
    operation reaches: every page, or — with ``folder`` a path — the pages
    filed in that folder or below it (properties.folder, gamma.foldertags
    rules). ``doc_id`` is "" for a page without a PDF."""
    path = clean_path(folder or "")
    pages = {}
    for page_id, content, props_raw in conn.execute(
            "SELECT id, content, properties FROM unified_blocks WHERE parent_id = 'root'"):
        try:
            props = json.loads(props_raw or "{}")
        except ValueError:
            props = {}
        if path and not any(path_within(t, path) for t in parse_tags(props.get("folder"))):
            continue
        attachment = page_attachment(props)
        pages[page_id] = {"title": content or "Untitled",
                          "doc_id": attachment["id"] if attachment else ""}
    return pages


def attachment_props(doc_id: str, source_url: str = "", original_filename: str = "") -> tuple[dict, str]:
    """What attaching a PDF writes on a page: ``({doc_id?, source_url?,
    original_filename?}, automatic title)``. The title is the upload's file
    name (its leaf — a browser may leak a relative path), else the URL's
    file name, else the doc id; callers store it as ``auto_title`` too, the
    compare-and-swap marker metadata_fetch replaces (an explicit rename
    clears it first — ub_update_block). Both creation paths (by-doc ingest,
    POST /pages/{id}/attachment) go through here so the rules match."""
    original = display_filename(original_filename)
    props = {}
    if doc_id:
        props["doc_id"] = doc_id
    if source_url:
        props["source_url"] = source_url
    if original:
        props["original_filename"] = original
    return props, original or url_filename(source_url) or doc_id


def create_page(conn, title: str, props: dict | None = None, *,
                block_id: str = "", position: str = "") -> dict:
    """Insert a new root page and return its block dict. Commits. Last in
    the library unless ``position`` (a sibling key the caller minted) says
    otherwise; ``block_id`` reuses an id (a page brought back) — its
    ``deleted_pages`` tombstone, if any, is cleared. The one code path that
    mints pages: POST /api/pages, POST /api/blocks (parent ``root``) and
    get_or_create_doc_page all go through it. The native blank-notebook
    endpoint supplies its client-minted UUID for idempotent retries."""
    block_id = block_id or secrets.token_urlsafe(9)
    title = (title or "").strip() or "Untitled"
    props = dict(props or {})
    now = page_now()
    new_pos = position or generate_key_between(last_child_position(conn, "root"), None)
    conn.execute(
        "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
        "VALUES (?, 'root', ?, ?, ?, ?, ?)",
        (block_id, new_pos, title, json.dumps(props), now, now),
    )
    conn.execute("DELETE FROM deleted_pages WHERE page_id = ?", (block_id,))
    conn.commit()
    return {
        "id": block_id, "parent_id": "root", "position": new_pos,
        "content": title, "properties": props, "created_at": now, "updated_at": now,
    }


def get_or_create_doc_page(conn, doc_id: str, default_title: str = "",
                           source_url: str | None = None,
                           original_filename: str | None = None,
                           folder: str = "", *, ws: str, actor: str = "") -> dict:
    """Lookup-or-create BY ATTACHMENT: the root page whose PDF attachment is
    `doc_id`, created under root when absent. Shared by POST /api/blocks/by-doc
    (PDF ingest from the app, "Open as document" on a PDF file block) and
    the extension's /api/clip (dedup). Pages without a PDF are created by
    POST /api/pages (create_page).

    The automatic title is the upload's file name, else ``default_title``
    (the caller's — a clip's tab title), else what ``attachment_props``
    derives (URL file name, doc id). ``folder`` (a path) files a NEW page;
    an existing page keeps its own. On an existing page this
    opportunistically backfills the source/filename markers (an op batch on
    the page, like every other write to an existing page — ``ws`` names the
    workspace, ``actor`` the account); auto_title is
    only set when the page still carries the exact title this call considers
    automatic, so a re-upload can never mark a user's custom title as
    replaceable by the metadata worker."""
    attachment, auto = attachment_props(doc_id, source_url or "", original_filename or "")
    original = attachment.get("original_filename", "")
    title = original or (default_title or "").strip() or auto
    row = page_for_doc(conn, doc_id, BLOCK_COLUMNS)
    if row:
        props = json.loads(row[4] or "{}")
        changed = False
        for key in ("source_url", "original_filename"):
            if attachment.get(key) and not props.get(key):
                props[key] = attachment[key]
                changed = True
        if not props.get("auto_title") and row[3] == title:
            props["auto_title"] = row[3]
            changed = True
        if changed:
            from .ops import after_commit, apply_ops, props_patch  # ops imports this module
            patch = props_patch(json.loads(row[4] or "{}"), props)
            after_commit(ws, conn, apply_ops(conn, row[0], [{"op": "set", "id": row[0], "props": patch}],
                                             actor=actor))
            row = (*row[:4], json.dumps(props), *row[5:])
        return block_to_dict(row)
    props = {**attachment, "auto_title": title}
    folder = clean_path(folder or "")
    if folder:
        props["folder"] = folder
    return create_page(conn, title, props)


def pages_for_docs(conn, hashes) -> dict:
    """Which root page a stored file became, batched: ``{hash: {"id",
    "title"}}`` for every hash that is some page's PDF attachment
    (``doc_id``) or the markdown file a note page was made from
    (``markdown_import`` — the upload's content digest, so a ``<hash>.md``
    chip finds its page). Hashes with no page are absent. Feeds the file
    chip's "Open page" / "Open as page" — one query per page render, never
    one per chip."""
    wanted = {str(d) for d in hashes if d}
    if not wanted:
        return {}
    found = {}
    for page_id, title, doc_id, md in conn.execute(
            "SELECT id, content, json_extract(properties, '$.doc_id'), "
            "json_extract(properties, '$.markdown_import') FROM unified_blocks "
            "WHERE parent_id = 'root' AND (json_extract(properties, '$.doc_id') IS NOT NULL "
            "OR json_extract(properties, '$.markdown_import') IS NOT NULL)"):
        for key in (doc_id, md):
            if key in wanted and key not in found:
                found[key] = {"id": page_id, "title": title}
    return found
