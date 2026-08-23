"""Library-organizer tools for the AI chat opened from the home/folder view.

A chat that is not tied to an open paper may organize the library agentically,
scoped to the folder the user is looking at: list the pages there, rename
them, and file them into (sub)folders.  Deliberately NOT offered: deleting
anything, editing note/highlight content, rewriting flat labels, or touching
pages outside the current folder — every allowed action is reversible with
another tool call, and each mutation is streamed back to the UI as an
``action`` event so the user sees exactly what changed.

Folder semantics mirror ``frontend/src/libraryUtils.js``: ``properties.folder``
is a comma-separated list of ``/``-nested paths, folders exist only through the
tags in use, and ``properties.category`` holds the flat labels.
"""

import json
import re
import sqlite3

from .db import page_now, user_db_path
from .logbuf import log

# Runaway guards for the tool loop, not workload caps: MAX_TOOL_ACTIONS bounds
# the real work, while the round limit only stops a loop that never converges.
# Rounds are generous because some models issue one call per round-trip even
# with parallel tool calls enabled.
MAX_TOOL_ROUNDS = 32    # provider round-trips per user message
MAX_TOOL_ACTIONS = 200  # mutations per user message (bulk renames are legit)
_LIST_CAP = 400         # pages listed per list_pages call
_TITLE_MAX = 300

FOLDER_TOOLS = [
    {
        "name": "list_pages",
        "description": (
            "List the pages (papers and notes) in the folder the user is viewing, one per "
            "line: id, title, kind (pdf/note), folder paths, labels, cached paper metadata "
            "(first author, year, venue) and last-update date. Call this before renaming or "
            "moving anything — never guess page ids."
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "rename_page",
        "description": "Set a page's title. Use exact page ids from list_pages.",
        "parameters": {
            "type": "object",
            "properties": {
                "page_id": {"type": "string"},
                "title": {"type": "string", "description": "the new title"},
            },
            "required": ["page_id", "title"],
        },
    },
    {
        "name": "move_page",
        "description": (
            'File a page into a folder. `folder` is a path like "readout/nondestructive" — '
            "'/' nests and a new path creates the folder. Paths outside the current folder "
            'are resolved as its subfolders; "" moves the page to the current folder itself '
            "(at the library root: out of every folder). Folder memberships outside the "
            "current folder are kept — folders are labels, a page can be in several."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "page_id": {"type": "string"},
                "folder": {"type": "string"},
            },
            "required": ["page_id", "folder"],
        },
    },
]


def organizer_system(scope: str) -> str:
    """System-prompt addendum describing the organizer role and its scope."""
    scope = clean_path(scope)
    where = f'the folder "{scope}"' if scope else "the root of their library"
    return (
        "You are also the user's library organizer. They are viewing " + where + " in "
        "Gamma, their PDF/notes library. Pages carry nested folder paths ('/' nests; a "
        "page may be in several folders) and flat labels; folders appear the moment a "
        "page is filed into them.\n"
        "When asked to organize, call list_pages first, then rename_page / move_page "
        "with exact page ids. Apply an explicit bulk instruction (e.g. a naming scheme) "
        "to every matching page without asking again; ask first when the request is "
        "ambiguous. You cannot delete anything, edit labels, or reach pages outside "
        "this folder. Finish with a short summary of what you changed."
    )


# --- folder-tag helpers (keep in sync with frontend/src/libraryUtils.js) ------

def parse_tags(raw: str) -> list[str]:
    return [t.strip() for t in (raw or "").split(",") if t.strip()]


def _clean_segment(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[,/]", " ", name or "")).strip()


def clean_path(path: str) -> str:
    return "/".join(s for s in (_clean_segment(p) for p in (path or "").split("/")) if s)


def _add_tag(tags: list[str], path: str) -> list[str]:
    """addFolderTag: keep other tags, but refine away ancestors of the new path."""
    return [t for t in tags if t != path and not path.startswith(t + "/")] + [path]


def _in_scope(tag: str, scope: str) -> bool:
    return tag == scope or tag.startswith(scope + "/")


def _page_in_scope(tags: list[str], scope: str) -> bool:
    return not scope or any(_in_scope(t, scope) for t in tags)


# --- execution ----------------------------------------------------------------

def _list_pages(conn, scope: str) -> str:
    rows = conn.execute(
        "SELECT id, content, properties, updated_at FROM unified_blocks "
        "WHERE parent_id = 'root' ORDER BY updated_at DESC"
    ).fetchall()
    lines = []
    for page_id, content, props_raw, updated in rows:
        try:
            props = json.loads(props_raw or "{}")
        except ValueError:
            props = {}
        tags = parse_tags(props.get("folder"))
        if not _page_in_scope(tags, scope):
            continue
        bits = [f"id={page_id}",
                f'title="{(content or "Untitled")[:120]}"',
                "pdf" if props.get("doc_id") else "note"]
        if tags:
            bits.append("folders=[" + ", ".join(tags) + "]")
        labels = parse_tags(props.get("category"))
        if labels:
            bits.append("labels=[" + ", ".join(labels) + "]")
        meta = props.get("meta") or {}
        authors = [a for a in (meta.get("authors") or []) if str(a).strip()]
        if authors or meta.get("year") or meta.get("venue"):
            first = str(authors[0]).split()[-1] if authors else ""
            who = f"{first} et al." if len(authors) > 1 else first
            bits.append("meta: " + ", ".join(
                x for x in (who, str(meta.get("year") or ""), str(meta.get("venue") or "")[:40]) if x))
        if updated:
            bits.append(f"updated {str(updated)[:10]}")
        lines.append("- " + " | ".join(bits))
    if not lines:
        return "The folder is empty." if scope else "The library is empty."
    header = f'Pages in "{scope}"' if scope else "Pages in the library"
    tail = f"\n(+{len(lines) - _LIST_CAP} more not shown)" if len(lines) > _LIST_CAP else ""
    return f"{header} ({len(lines)}):\n" + "\n".join(lines[:_LIST_CAP]) + tail


def run_folder_tool(user: str, scope: str, name: str, args: dict) -> tuple[str, dict | None]:
    """Execute one organizer tool call.

    Returns ``(result_text, action)`` — result_text goes back to the model,
    action (mutations only) is the ``{kind, summary}`` event streamed to the UI
    and saved with the chat message.
    """
    scope = clean_path(scope)
    args = args if isinstance(args, dict) else {}
    try:
        with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
            if name == "list_pages":
                return _list_pages(conn, scope), None
            if name not in ("rename_page", "move_page"):
                return f"error: unknown tool {name}", None

            page_id = str(args.get("page_id") or "").strip()
            row = conn.execute(
                "SELECT parent_id, content, properties FROM unified_blocks WHERE id = ?",
                (page_id,),
            ).fetchone()
            if not row or row[0] != "root":
                return "error: no such page — use ids from list_pages", None
            title = row[1] or "Untitled"
            props = json.loads(row[2] or "{}")
            tags = parse_tags(props.get("folder"))
            if not _page_in_scope(tags, scope):
                return "error: page is outside the current folder", None

            if name == "rename_page":
                new = re.sub(r"\s+", " ", str(args.get("title") or "")).strip()[:_TITLE_MAX]
                if not new:
                    return "error: empty title", None
                if new == title:
                    return "ok — title already is that", None
                conn.execute("UPDATE unified_blocks SET content = ?, updated_at = ? WHERE id = ?",
                             (new, page_now(), page_id))
                conn.commit()
                return (f'ok — renamed to "{new}"',
                        {"kind": "rename", "page_id": page_id,
                         "summary": f"Renamed “{title}” → “{new}”"})

            # move_page
            target = clean_path(str(args.get("folder") or ""))
            if scope and target and not _in_scope(target, scope):
                target = f"{scope}/{target}"  # relative paths land inside the scope
            elif scope and not target:
                target = scope
            kept = [t for t in tags if scope and not _in_scope(t, scope)]
            new_tags = _add_tag(kept, target) if target else kept
            if new_tags == tags:
                return "ok — page is already there", None
            props["folder"] = ", ".join(new_tags)
            conn.execute("UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?",
                         (json.dumps(props), page_now(), page_id))
            conn.commit()
            where = target or "the library root"
            return (f'ok — moved to "{where}"',
                    {"kind": "move", "page_id": page_id,
                     "summary": f"Moved “{title}” → {where}"})
    except Exception as e:  # a tool failure must never kill the chat stream
        log.warning(f"[ai_tools] {name} failed: {e}")
        return f"error: {e}", None
