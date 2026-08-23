"""Agent tools for the AI chat — a scope-agnostic tool registry.

Every chat has a *scope* deciding what its tools can touch:

- ``{"type": "folder", "folder": path}`` — the home/folder chat; tools reach
  the pages in that folder ("" = the whole library).
- ``{"type": "page", "page_id": id}`` — the per-paper chat; tools reach only
  that paper.

Each TOOLS entry declares its wire spec, the Settings permission key
(Settings → Assistant → Folder agent), the scopes it exists in, whether it
mutates, and its executor — so arming a chat is one filter
(:func:`agent_tools`) and dispatch is one lookup (:func:`run_agent_tool`),
with the in-scope check shared by every executor.

Reads: list the pages (folder scope only); read a paper (extracted PDF text
plus the user's highlights and notes); full-text-search PDF contents via the
existing FTS index.  Writes (folder scope only): rename pages; file them into
(sub)folders.  Deliberately NOT offered under any permission: deleting
anything, editing note/highlight content, rewriting flat labels, or touching
pages outside the scope — every mutation is reversible with another tool call,
and every successful call is streamed back to the UI as an ``action`` event so
the user sees exactly what the agent did.  The human-facing description lives
in ``docs/dev/agent.md``; the base role prompt (AGENT_PROMPT) is user-editable in the
prompt editor, the scope/permission lines are appended mechanically.

Folder semantics mirror ``frontend/src/libraryUtils.js``: ``properties.folder``
is a comma-separated list of ``/``-nested paths, folders exist only through the
tags in use, and ``properties.category`` holds the flat labels.
"""

import json
import re
import sqlite3

from .ai_context import page_report_section
from .db import page_now, user_db_path
from .logbuf import log
from .textnorm import INDEX_VERSION

# Runaway guards for the tool loop, not workload caps: MAX_TOOL_ACTIONS bounds
# the real work (mutations only), while the round limit stops a loop that
# never converges. Rounds are generous because some models issue one call per
# round-trip even with parallel tool calls enabled.
MAX_TOOL_ROUNDS = 32    # provider round-trips per user message
MAX_TOOL_ACTIONS = 200  # mutations per user message (bulk renames are legit)
_LIST_CAP = 400         # pages listed per list_pages call
_TITLE_MAX = 300
_DETAIL_CAP = 4000      # chars of a tool's output kept for the chat's expandable chip
_ARG_CAP = 400          # chars per argument value in that chip

# Base role prompt — the user-editable part (prompt editor, "Library agent");
# agent_system() appends the mechanical scope/permission lines to it.
AGENT_PROMPT = (
    "You are also the user's library agent in Gamma, their PDF/notes library. "
    "Pages carry nested folder paths ('/' nests; a page may be in several folders) "
    "and flat labels; folders appear the moment a page is filed into them. Never "
    "guess page ids. Use the reading tools to answer questions about the papers "
    "themselves — e.g. to compare papers or write a summary. When asked to "
    "organize, apply an explicit bulk instruction (e.g. a naming scheme) to every "
    "matching page without asking again; ask first when the request is ambiguous. "
    "You cannot delete anything or edit labels. After making changes, finish with "
    "a short summary of what you changed."
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


def _in_scope(tag: str, scope_path: str) -> bool:
    return tag == scope_path or tag.startswith(scope_path + "/")


# --- scope ---------------------------------------------------------------------

def _scope_folder(scope: dict) -> str:
    return clean_path(scope.get("folder") or "")


def _page_in_scope(scope: dict, page_id: str, tags: list[str]) -> bool:
    if scope.get("type") == "page":
        return page_id == scope.get("page_id")
    path = _scope_folder(scope)
    return not path or any(_in_scope(t, path) for t in tags)


def _load_scoped_page(conn, scope: dict, args: dict):
    """Fetch the target page and enforce the scope. Returns
    ``((page_id, title, props, tags), error)`` — exactly one side is set."""
    page_id = str(args.get("page_id") or "").strip()
    row = conn.execute(
        "SELECT parent_id, content, properties FROM unified_blocks WHERE id = ?",
        (page_id,),
    ).fetchone()
    if not row or row[0] != "root":
        return None, "error: no such page — use exact page ids"
    props = json.loads(row[2] or "{}")
    tags = parse_tags(props.get("folder"))
    if not _page_in_scope(scope, page_id, tags):
        return None, "error: page is outside this chat's scope"
    return (page_id, row[1] or "Untitled", props, tags), None


def _scope_docs(conn, scope: dict) -> dict:
    """doc_id → title for every PDF paper the scope can reach."""
    if scope.get("type") == "page":
        loaded, error = _load_scoped_page(conn, scope, {"page_id": scope.get("page_id")})
        if error:
            return {}
        _, title, props, _ = loaded
        return {props["doc_id"]: title} if props.get("doc_id") else {}
    docs = {}
    for _, content, props_raw in conn.execute(
            "SELECT id, content, properties FROM unified_blocks WHERE parent_id = 'root'"):
        try:
            props = json.loads(props_raw or "{}")
        except ValueError:
            continue
        if props.get("doc_id") and _page_in_scope(scope, "", parse_tags(props.get("folder"))):
            docs[props["doc_id"]] = content or "Untitled"
    return docs


# --- executors -----------------------------------------------------------------
# Each returns (result_text, action): result_text goes back to the model;
# action is the {kind, summary} event streamed to the UI and saved with the
# chat message, for every successful call (reads included); errors carry None.

def _run_list_pages(conn, user: str, scope: dict, args: dict):
    path = _scope_folder(scope)
    lines = []
    for page_id, content, props_raw, updated in conn.execute(
            "SELECT id, content, properties, updated_at FROM unified_blocks "
            "WHERE parent_id = 'root' ORDER BY updated_at DESC"):
        try:
            props = json.loads(props_raw or "{}")
        except ValueError:
            props = {}
        tags = parse_tags(props.get("folder"))
        if not _page_in_scope(scope, page_id, tags):
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
    where = f"“{path}”" if path else "the library"
    action = {"kind": "list",
              "summary": f"Listed {len(lines)} page{'s' if len(lines) != 1 else ''} in {where}"}
    if not lines:
        return ("The folder is empty." if path else "The library is empty."), action
    header = f'Pages in "{path}"' if path else "Pages in the library"
    tail = f"\n(+{len(lines) - _LIST_CAP} more not shown)" if len(lines) > _LIST_CAP else ""
    return f"{header} ({len(lines)}):\n" + "\n".join(lines[:_LIST_CAP]) + tail, action


def _run_read_page(conn, user: str, scope: dict, args: dict):
    loaded, error = _load_scoped_page(conn, scope, args)
    if error:
        return error, None
    page_id, title, _, _ = loaded
    try:
        budget = max(0, min(int(args.get("pdf_chars", 6000)), 20000))
    except (TypeError, ValueError):
        budget = 6000
    section = page_report_section(conn, user, page_id, budget)
    if not section:
        return f'"{title}" has no readable content', None
    return section, {"kind": "read", "page_id": page_id, "summary": f"Read “{title[:60]}”"}


def _run_search_pdfs(conn, user: str, scope: dict, args: dict):
    """FTS snippets from the in-scope papers' PDF text (same index and query
    rules as /api/pdf-search); un-indexed papers are kicked to the background
    indexer and reported so the model knows results may be incomplete."""
    query = str(args.get("query") or "").strip()
    if not query:
        return "error: empty query", None
    try:
        limit = max(1, min(int(args.get("limit") or 12), 30))
    except (TypeError, ValueError):
        limit = 12
    docs = _scope_docs(conn, scope)
    if not docs:
        return ("No PDF papers are reachable from this chat.",
                {"kind": "search", "summary": f"Searched PDFs for “{query[:60]}” — no papers"})
    # Local import: keep gamma.* module load free of the routers package.
    from .routers.search import _ensure_schema, _fts_query, _index_missing_async
    lines = []
    with sqlite3.connect(user_db_path(user, "data.db")) as database:
        _ensure_schema(database)
        current = {r[0] for r in database.execute(
            "SELECT doc_id FROM pdf_fts_docs WHERE ver = ?", (INDEX_VERSION,))}
        missing = [d for d in docs if d not in current]
        if missing:
            _index_missing_async(user, missing)
        match = _fts_query(query)
        if match:
            try:
                for doc_id, page, snippet in database.execute(
                        "SELECT doc_id, page, snippet(pdf_fts, 2, '', '', '…', 14) FROM pdf_fts "
                        "WHERE pdf_fts MATCH ? ORDER BY rank LIMIT ?", (match, limit * 4)):
                    title = docs.get(doc_id)
                    if not title:
                        continue  # out-of-scope or deleted paper
                    lines.append(f'- "{title[:80]}" p.{page}: {snippet}')
                    if len(lines) >= limit:
                        break
            except sqlite3.OperationalError:
                pass  # malformed MATCH — treat as no results
    out = (f'PDF text matches for "{query}" ({len(lines)}):\n' + "\n".join(lines)
           if lines else f'No PDF text matches for "{query}".')
    if missing:
        out += (f"\n({len(missing)} paper(s) not indexed yet — indexing started, "
                "search again shortly for complete results)")
    return out, {"kind": "search",
                 "summary": f"Searched PDFs for “{query[:60]}” — "
                            f"{len(lines)} hit{'s' if len(lines) != 1 else ''}"}


def _run_rename_page(conn, user: str, scope: dict, args: dict):
    loaded, error = _load_scoped_page(conn, scope, args)
    if error:
        return error, None
    page_id, title, _, _ = loaded
    new = re.sub(r"\s+", " ", str(args.get("title") or "")).strip()[:_TITLE_MAX]
    if not new:
        return "error: empty title", None
    if new == title:
        return "ok — title already is that", None
    conn.execute("UPDATE unified_blocks SET content = ?, updated_at = ? WHERE id = ?",
                 (new, page_now(), page_id))
    conn.commit()
    return (f'ok — renamed to "{new}"',
            {"kind": "rename", "page_id": page_id, "summary": f"Renamed “{title}” → “{new}”"})


def _run_move_page(conn, user: str, scope: dict, args: dict):
    loaded, error = _load_scoped_page(conn, scope, args)
    if error:
        return error, None
    page_id, title, props, tags = loaded
    path = _scope_folder(scope)
    target = clean_path(str(args.get("folder") or ""))
    if path and target and not _in_scope(target, path):
        target = f"{path}/{target}"  # relative paths land inside the scope
    elif path and not target:
        target = path
    kept = [t for t in tags if path and not _in_scope(t, path)]
    new_tags = _add_tag(kept, target) if target else kept
    if new_tags == tags:
        return "ok — page is already there", None
    props["folder"] = ", ".join(new_tags)
    conn.execute("UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?",
                 (json.dumps(props), page_now(), page_id))
    conn.commit()
    where = target or "the library root"
    return (f'ok — moved to "{where}"',
            {"kind": "move", "page_id": page_id, "summary": f"Moved “{title}” → {where}"})


# --- registry ------------------------------------------------------------------
# One entry per tool: wire spec, Settings permission key, the action kind its
# chip carries, the scopes the tool exists in, whether it mutates the library,
# and its executor.

_PAGE_ID_ARG = {"page_id": {"type": "string"}}

TOOLS = [
    {
        "perm": "list", "kind": "list", "scopes": ("folder",), "mutating": False, "run": _run_list_pages,
        "spec": {
            "name": "list_pages",
            "description": (
                "List the pages (papers and notes) in the folder the user is viewing, one "
                "per line: id, title, kind (pdf/note), folder paths, labels, cached paper "
                "metadata (first author, year, venue) and last-update date. Call this "
                "before any other tool — never guess page ids."),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "perm": "read", "kind": "read", "scopes": ("folder", "page"), "mutating": False, "run": _run_read_page,
        "spec": {
            "name": "read_page",
            "description": (
                "Read one page this chat can reach: an excerpt of the paper's extracted "
                "PDF text plus the user's highlighted passages and notes. Use it to answer "
                "questions about specific papers or to write summaries/reports across "
                "several. `pdf_chars` sets how much document text to include (default "
                "6000, up to 20000; 0 = notes only)."),
            "parameters": {
                "type": "object",
                "properties": {**_PAGE_ID_ARG, "pdf_chars": {"type": "integer"}},
                "required": ["page_id"],
            },
        },
    },
    {
        "perm": "search", "kind": "search", "scopes": ("folder", "page"), "mutating": False, "run": _run_search_pdfs,
        "spec": {
            "name": "search_pdfs",
            "description": (
                "Full-text search over the PDF contents of the papers this chat can reach "
                "(pre-built index; snippets with page numbers). Use it to find where a "
                "topic is discussed before read_page-ing the relevant pages."),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "description": "max hits, default 12"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "perm": "rename", "kind": "rename", "scopes": ("folder",), "mutating": True, "run": _run_rename_page,
        "spec": {
            "name": "rename_page",
            "description": "Set a page's title. Use exact page ids from list_pages.",
            "parameters": {
                "type": "object",
                "properties": {**_PAGE_ID_ARG,
                               "title": {"type": "string", "description": "the new title"}},
                "required": ["page_id", "title"],
            },
        },
    },
    {
        "perm": "move", "kind": "move", "scopes": ("folder",), "mutating": True, "run": _run_move_page,
        "spec": {
            "name": "move_page",
            "description": (
                'File a page into a folder. `folder` is a path like '
                '"readout/nondestructive" — \'/\' nests and a new path creates the '
                "folder. Paths outside the current folder are resolved as its "
                'subfolders; "" moves the page to the current folder itself (at the '
                "library root: out of every folder). Folder memberships outside the "
                "current folder are kept — folders are labels, a page can be in several."),
            "parameters": {
                "type": "object",
                "properties": {**_PAGE_ID_ARG, "folder": {"type": "string"}},
                "required": ["page_id", "folder"],
            },
        },
    },
]

_BY_NAME = {t["spec"]["name"]: t for t in TOOLS}
MUTATING_TOOLS = {t["spec"]["name"] for t in TOOLS if t["mutating"]}


def agent_tools(scope_type: str, perms: dict | None = None) -> list:
    """The armed tool specs for a chat scope and the user's per-tool permission
    map (missing key = allowed, so new tools default on). [] = plain chat."""
    perms = perms if isinstance(perms, dict) else {}
    return [t["spec"] for t in TOOLS
            if scope_type in t["scopes"] and perms.get(t["perm"], True)]


def agent_system(scope: dict, perms: dict | None = None, base: str = "") -> str:
    """System-prompt addendum: the (user-editable) base role prompt plus
    mechanical lines describing this chat's scope and armed tools."""
    armed = agent_tools(scope.get("type") or "", perms)
    names = [t["name"] for t in armed]
    text = (base.strip() or AGENT_PROMPT) + "\n"
    if scope.get("type") == "page":
        text += (f'This chat is about one page (page_id "{scope.get("page_id")}") — '
                 "the tools reach only it.\n")
    else:
        path = _scope_folder(scope)
        where = f'the folder "{path}"' if path else "the root of their library"
        text += f"The user is viewing {where}; only pages in it are reachable.\n"
    text += f"Available tools: {', '.join(names)}. Any other tool is disabled in the user's settings."
    if not any(n in MUTATING_TOOLS for n in names):
        text += " Renaming and moving pages is not available here — suggest changes instead of attempting them."
    return text


def tool_action(kind: str, summary: str, name: str, args: dict, result: str,
                error: bool = False, **extra) -> dict:
    """Build the UI event for one tool call: the chip's icon/summary plus the
    raw call the chat can expand — the arguments and the output the model got,
    both truncated (chips are streamed AND saved with the message)."""
    trimmed = {}
    for key, value in (args or {}).items():
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        trimmed[key] = text if len(text) <= _ARG_CAP else text[:_ARG_CAP] + "…"
    out = {"kind": kind, "summary": summary, "tool": name, "args": trimmed,
           "result": result if len(result) <= _DETAIL_CAP
                     else result[:_DETAIL_CAP] + f"\n… (+{len(result) - _DETAIL_CAP} more chars)"}
    if error:
        out["error"] = True
    return {**out, **extra}


def run_agent_tool(user: str, scope: dict, name: str, args: dict) -> tuple[str, dict]:
    """Execute one agent tool call against the chat's scope.

    Returns ``(result_text, action)`` — result_text goes back to the model;
    action is the ``{kind, summary, tool, args, result}`` UI event for EVERY
    call (reads and failures included), so nothing the agent does is invisible.
    Failures carry ``error: True``; the executors' own actions are enriched
    with the same raw-call fields.
    """
    tool = _BY_NAME.get(name)
    args = args if isinstance(args, dict) else {}
    if not tool or (scope.get("type") or "") not in tool["scopes"]:
        result = f"error: unknown tool {name}"
        return result, tool_action("error", result[:200], name, args, result, error=True)
    try:
        with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
            result, action = tool["run"](conn, user, scope, args)
    except Exception as e:  # a tool failure must never kill the chat stream
        log.warning(f"[ai_tools] {name} failed: {e}")
        result, action = f"error: {e}", None
    if action is None:
        # No-op or refused call (empty title, page out of scope, …): still show
        # it, tagged as an error only when the tool actually failed.
        failed = result.startswith("error")
        action = {"kind": "error" if failed else tool["kind"],
                  "summary": result.split("\n")[0][:200], "error": failed}
    return result, tool_action(action["kind"], action["summary"], name, args, result,
                               error=bool(action.get("error")),
                               **{k: v for k, v in action.items()
                                  if k not in ("kind", "summary", "error")})
