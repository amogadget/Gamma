"""The workspace change feed: what changed since a cursor, for anything that
keeps a copy of a workspace in step (a desktop mirror, a backup merge).

``GET /api/sync/changes?since=&limit=`` lists the pages whose root block was
stamped after the cursor (every writer stamps the page root once per batch:
``apply_ops``, ``record_ops``, ``log_reload``, the raw import paths) and the
``deleted_pages`` tombstones written after it, as one stream ordered by
time. The feed is a HINT, not the truth: a page's own op log (``seq``,
``GET /pages/{id}/ops?since=``) says what actually changed, and the
consumer must be idempotent, because

- pagination re-lists nothing (the cursor is ``<time>|<id>``, strict), but
- a caught-up answer's cursor is moved back by ``GRACE_SECONDS``: a writer
  that computed its timestamp before another one committed (an import
  holds one ``now`` for its whole run) would otherwise slip behind a cursor
  taken between the two, so the last minute is re-listed on every poll.

Members read it (viewers too); share links do not.
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Request

from .. import workspaces
from ..auth import require_ws, ws_role
from ..db import connect_pages_db, page_now

router = APIRouter(prefix="/api", tags=["sync"])

GRACE_SECONDS = 60
MAX_LIMIT = 2000


def _split_cursor(since: str) -> tuple[str, str]:
    at, _, block_id = (since or "").partition("|")
    return at, block_id


def _cursor(at: str, block_id: str = "") -> str:
    return f"{at}|{block_id}" if block_id else at


def _grace_cursor() -> str:
    now = datetime.strptime(page_now(), "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    return (now - timedelta(seconds=GRACE_SECONDS)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def changes(conn, since: str, limit: int) -> dict:
    """The feed over an open pages.db: ``{since, cursor, more, pages: [{id,
    created_at, updated_at, seq}], deleted: [{id, deleted_at, actor}]}``."""
    at, block_id = _split_cursor(since)
    after = "(%s > ? OR (%s = ? AND %s > ?))"
    pages = conn.execute(
        "SELECT b.id, b.created_at, b.updated_at, COALESCE(MAX(o.seq), 0) FROM unified_blocks b "
        "LEFT JOIN page_ops o ON o.page_id = b.id WHERE b.parent_id = 'root' AND "
        + after % ("b.updated_at", "b.updated_at", "b.id") +
        " GROUP BY b.id ORDER BY b.updated_at, b.id LIMIT ?",
        (at, at, block_id, limit + 1)).fetchall()
    deleted = conn.execute(
        "SELECT page_id, deleted_at, actor FROM deleted_pages WHERE "
        + after % ("deleted_at", "deleted_at", "page_id") +
        " ORDER BY deleted_at, page_id LIMIT ?",
        (at, at, block_id, limit + 1)).fetchall()
    stream = sorted(
        [(r[2], r[0], "page", r) for r in pages] + [(r[1], r[0], "deleted", r) for r in deleted])
    more = len(stream) > limit
    stream = stream[:limit]
    out = {"since": since or "", "pages": [], "deleted": [], "more": more}
    for _, _, kind, r in stream:
        if kind == "page":
            out["pages"].append({"id": r[0], "created_at": r[1], "updated_at": r[2], "seq": r[3]})
        else:
            out["deleted"].append({"id": r[0], "deleted_at": r[1], "actor": r[2]})
    if more:
        out["cursor"] = _cursor(stream[-1][0], stream[-1][1])
    else:
        grace = _grace_cursor()
        # never move a cursor backwards past what the caller already had
        out["cursor"] = max(grace, at) if at else grace
    return out


@router.get("/sync/whoami")
async def sync_whoami(request: Request):
    """Who the credential is and what it may do here: ``{user, workspace:
    {id, name}, role, scope}`` — ``scope`` is the integration token's
    (``read`` / ``write``), ``session`` for a signed-in browser. A mirror
    checks this before it is created and at the start of every round."""
    ws = require_ws(request)
    info = workspaces.get(ws) or {}
    return {"user": request.state.user, "workspace": {"id": ws, "name": info.get("name", "")},
            "role": ws_role(request),
            "scope": request.state.token_scope if getattr(request.state, "auth", "") == "token" else "session"}


@router.get("/sync/changes")
async def sync_changes(request: Request, since: str = "", limit: int = 500):
    """Pages changed and pages deleted since ``since`` (``""`` = everything),
    at most ``limit`` entries, with the cursor to continue from."""
    ws = require_ws(request)
    limit = max(1, min(int(limit or 500), MAX_LIMIT))
    with connect_pages_db(ws) as conn:
        return changes(conn, since, limit)
