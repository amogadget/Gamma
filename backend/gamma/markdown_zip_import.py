"""Import a zip of Markdown notes as pages — Notion's "Markdown & CSV" export,
Gamma's own Markdown export, or any zipped folder of ``.md`` files. One logic
serves all three, because they only differ in naming conventions:

- every ``.md`` becomes a note page; its title is the front-matter ``title``,
  else the leading ``# H1``, else the filename (Notion's ``Title <32-hex id>``
  suffix stripped);
- directories become folder labels (Notion puts a page's subpages in a folder
  named after the page, so the page tree becomes the folder tree); a
  front-matter ``folder:`` (what Gamma's export writes, relative to the
  exported folder) wins over the directory; the caller's ``folder`` prefix
  goes in front of both;
- relative links to other ``.md`` files in the zip become ``[[page]]``
  mentions, links to bundled images / PDFs / files upload the file (content-
  hash dedup, storage limits per file) and point at ``/api/uploads/…``;
- a Notion database (``Name <id>.csv`` — the ``_all`` variant when both exist,
  it carries every row) becomes a page holding the table, its row pages
  (``Name <id>/Row <id>.md``) land in a folder of the same name; Notion's
  ``<aside>`` callouts become ``> [!info]`` callouts;
- Gamma's front matter (``source`` → the bundled PDF or its URL, ``doi`` /
  ``authors`` / ``year`` → metadata) and BibTeX block are restored;
- a ``.md`` already imported (same bytes, or the same Notion page id) is
  skipped, so re-importing an export adds nothing; links to it still resolve
  to the existing page. Notion splits big exports into ``Part-N.zip`` members
  and wraps workspace exports in ``Export-<uuid>/``: nested zips are read in
  place, one common root directory (and any such wrapper) is dropped.
"""

import csv
import io
import json
import posixpath
import re
import secrets
import unicodedata
import zipfile
from urllib.parse import unquote

from fastapi import HTTPException
from fractional_indexing import generate_key_between, generate_n_keys_between

from .blocks_store import last_child_position
from .foldertags import clean_path, clean_segment
from .logbuf import log
from .markdown_import import MAX_MARKDOWN_BYTES, md_to_blocks, parse_frontmatter
from .storage import FILE_MEDIA_TYPES, IMAGE_MEDIA_TYPES, content_digest, is_pdf, store_file

MAX_PAGES = 2000
MAX_TOTAL_BYTES = 1 << 30        # uncompressed, across nested zips
MAX_NESTED_ZIPS = 50
MAX_TABLE_ROWS = 500
MAX_TABLE_COLS = 40

_MD_EXTS = (".md", ".markdown")
_NOTION_ID_RE = re.compile(r"\s+[0-9a-f]{32}$", re.I)
_EXPORT_WRAPPER_RE = re.compile(r"^Export-[0-9a-f-]{8,}$", re.I)
_H1_RE = re.compile(r"^#\s+(.+?)\s*#*\s*$")
_BIBTEX_RE = re.compile(r"^```bibtex[ \t]*\n(.*?)\n```[ \t]*\n?", re.S)
_ASIDE_RE = re.compile(r"<aside>\s*(.*?)\s*</aside>", re.S)
# [label](target "title") / ![alt](target) — label may hold one level of []
_LINK_RE = re.compile(r"(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^)\s]+)((?:\s+\"[^\"]*\")?)\s*\)")
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_ASSET_EXTS = set(IMAGE_MEDIA_TYPES) | set(FILE_MEDIA_TYPES) | {".pdf"}


# --- zip walking -------------------------------------------------------------

class _Entry:
    __slots__ = ("path", "size", "_zf", "_info")

    def __init__(self, path, zf, info):
        self.path = path
        self.size = info.file_size
        self._zf, self._info = zf, info

    def read(self) -> bytes:
        return self._zf.read(self._info)


def _entry_name(zi) -> str:
    name = zi.filename
    if not (zi.flag_bits & 0x800):  # no UTF-8 flag: zipfile decoded cp437
        try:
            name = name.encode("cp437").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return unicodedata.normalize("NFC", name.replace("\\", "/")).lstrip("/")


def _walk_zip(zf, prefix, out, budget, opened, depth=0):
    for zi in zf.infolist():
        if zi.is_dir():
            continue
        name = _entry_name(zi)
        parts = name.split("/")
        if any(p in ("__MACOSX", ".DS_Store", "") or p.startswith("._") for p in parts):
            continue
        full = f"{prefix}{name}"
        if name.lower().endswith(".zip") and depth < 2 and len(opened) < MAX_NESTED_ZIPS:
            # Notion's Part-N.zip: its members are siblings of the part file.
            try:
                inner = zipfile.ZipFile(io.BytesIO(zf.read(zi)))
            except zipfile.BadZipFile:
                continue
            opened.append(inner)
            _walk_zip(inner, posixpath.dirname(full) + "/" if "/" in full else "",
                      out, budget, opened, depth + 1)
            continue
        budget["bytes"] += zi.file_size
        if budget["bytes"] > MAX_TOTAL_BYTES:
            raise HTTPException(status_code=413, detail="zip too large (1 GB uncompressed limit)")
        out.append(_Entry(full, zf, zi))


def _strip_wrappers(entries):
    """Drop one common root directory (a zipped folder) plus any number of
    Notion ``Export-<uuid>`` wrappers so paths start at the notes."""
    stripped_plain = False
    while entries:
        tops = {e.path.split("/", 1)[0] for e in entries}
        if len(tops) != 1 or not all("/" in e.path for e in entries):
            break
        top = next(iter(tops))
        if _EXPORT_WRAPPER_RE.match(top):
            pass
        elif stripped_plain:
            break
        else:
            stripped_plain = True
        for e in entries:
            e.path = e.path.split("/", 1)[1]


# --- naming ------------------------------------------------------------------

def _notion_id(stem: str):
    m = _NOTION_ID_RE.search(stem)
    return m.group(0).strip().lower() if m else None


def _clean_stem(stem: str) -> str:
    return _NOTION_ID_RE.sub("", stem).strip() or stem.strip()


def _dir_folder(path: str) -> str:
    dirname = posixpath.dirname(path)
    if not dirname:
        return ""
    return "/".join(s for s in (clean_segment(_clean_stem(seg)) for seg in dirname.split("/")) if s)


def _split_ext(path: str):
    leaf = posixpath.basename(path)
    dot = leaf.rfind(".")
    return (leaf[:dot], leaf[dot:].lower()) if dot > 0 else (leaf, "")


# --- body preparation --------------------------------------------------------

def _take_title(body: str, fm_title):
    """Use (and strip) a leading ``# H1`` as the title when there is no front-
    matter title or it repeats it — Notion and Gamma both write one."""
    lines = body.lstrip("\n").split("\n")
    m = _H1_RE.match(lines[0]) if lines else None
    if not m:
        return fm_title, body
    h1 = m.group(1).strip()
    if fm_title and h1 != fm_title:
        return fm_title, body
    return h1, "\n".join(lines[1:]).lstrip("\n")


def _take_bibtex(body: str):
    m = _BIBTEX_RE.match(body)
    if not m:
        return None, body
    return m.group(1).strip(), body[m.end():].lstrip("\n")


def _convert_asides(body: str) -> str:
    def repl(m):
        lines = [ln.rstrip() for ln in m.group(1).strip().split("\n")]
        return "\n".join([f"> [!info] {lines[0]}"] + [f"> {ln}" for ln in lines[1:]])
    return _ASIDE_RE.sub(repl, body)


def _csv_to_markdown(data: bytes) -> str:
    """A Notion database CSV → GFM table (capped, cells pipe-escaped)."""
    text = data.decode("utf-8-sig", errors="replace")
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    if not rows:
        return ""
    width = min(max(len(r) for r in rows), MAX_TABLE_COLS)

    def cell(v):
        return re.sub(r"\s*\n\s*", "<br>", (v or "").strip()).replace("|", "\\|") or " "

    def line(r):
        return "| " + " | ".join(cell(c) for c in (r + [""] * width)[:width]) + " |"

    out = [line(rows[0]), "|" + "|".join(" --- " for _ in range(width)) + "|"]
    out += [line(r) for r in rows[1:MAX_TABLE_ROWS + 1]]
    if len(rows) - 1 > MAX_TABLE_ROWS:
        out.append(f"\n*… {len(rows) - 1 - MAX_TABLE_ROWS} more rows not shown*")
    return "\n".join(out)


# --- storing -----------------------------------------------------------------

def insert_note_page(conn, page_id, title, props, tree, now) -> int:
    """Insert a root page (last on root) plus its ``{content, children}``
    tree; returns the number of note blocks written."""
    pos = generate_key_between(last_child_position(conn, "root"), None)
    conn.execute(
        "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
        "VALUES (?,'root',?,?,?,?,?)",
        (page_id, pos, title, json.dumps(props), now, now),
    )
    imported = 0
    pending = [(page_id, tree)]
    while pending:
        parent_id, nodes = pending.pop()
        if not nodes:
            continue
        positions = generate_n_keys_between(None, None, n=len(nodes))
        for node, child_pos in zip(nodes, positions):
            child_id = secrets.token_urlsafe(9)
            conn.execute(
                "INSERT INTO unified_blocks (id,parent_id,position,content,properties,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (child_id, parent_id, child_pos, node.get("content", ""), "{}", now, now),
            )
            imported += 1
            if node.get("children"):
                pending.append((child_id, node["children"]))
    return imported


class _Plan:
    __slots__ = ("entry", "page_id", "title", "folder", "body", "props", "existing")

    def __init__(self, entry):
        self.entry = entry
        self.page_id = secrets.token_urlsafe(9)
        self.title = ""
        self.folder = ""
        self.body = ""
        self.props = {}
        self.existing = False


def import_markdown_zip(ws: str, zf: zipfile.ZipFile, conn, folder: str = "",
                        now: str = "") -> dict:
    """Import every note in ``zf`` into workspace ``ws`` through the open ``pages.db``
    connection (the caller commits). Returns the report dict."""
    prefix = clean_path(folder)
    entries, opened = [], []
    _walk_zip(zf, "", entries, {"bytes": 0}, opened)
    _strip_wrappers(entries)
    report = {"pages_created": 0, "pages_skipped": 0, "blocks_imported": 0,
              "assets_stored": 0, "links_resolved": 0, "notion": False,
              "pages": [], "warnings": []}

    def warn(title, reason):
        if len(report["warnings"]) < 200:
            report["warnings"].append({"title": title, "reason": reason})

    notes = sorted((e for e in entries if _split_ext(e.path)[1] in _MD_EXTS),
                   key=lambda e: (e.path.count("/"), e.path.lower()))
    csvs = [e for e in entries if _split_ext(e.path)[1] == ".csv"]
    assets = {e.path: e for e in entries if _split_ext(e.path)[1] in _ASSET_EXTS}
    if not notes and not csvs:
        raise HTTPException(status_code=400, detail="no .md files in the zip")

    # Notion writes `Name <id>.csv` and `Name <id>_all.csv` for one database
    # (the latter has every row regardless of the view); keep one page per
    # database and let links to either file resolve to it.
    databases, csv_alias = {}, {}
    for e in csvs:
        stem, _ = _split_ext(e.path)
        key = (posixpath.dirname(e.path), _clean_stem(re.sub(r"_all$", "", stem)).lower())
        cur = databases.get(key)
        if cur is None or (stem.endswith("_all") and not _split_ext(cur.path)[0].endswith("_all")):
            databases[key] = e
    for e in csvs:
        stem, _ = _split_ext(e.path)
        key = (posixpath.dirname(e.path), _clean_stem(re.sub(r"_all$", "", stem)).lower())
        csv_alias[e.path] = databases[key]

    # Already-imported pages: same bytes, or the same Notion page.
    by_digest, by_notion = {}, {}
    for pid, raw_props in conn.execute(
            "SELECT id, properties FROM unified_blocks WHERE parent_id = 'root'"):
        try:
            props = json.loads(raw_props or "{}")
        except (TypeError, ValueError):
            continue
        if props.get("markdown_import"):
            by_digest.setdefault(props["markdown_import"], pid)
        if props.get("notion_id"):
            by_notion.setdefault(props["notion_id"], pid)

    plans, targets = [], {}
    for e in notes + list(databases.values()):
        if len(plans) >= MAX_PAGES:
            warn(e.path, f"more than {MAX_PAGES} notes — the rest were skipped")
            break
        if e.size > MAX_MARKDOWN_BYTES:
            warn(e.path, "file exceeds 5 MB")
            continue
        raw = e.read()
        plan = _Plan(e)
        stem, ext = _split_ext(e.path)
        notion_id = _notion_id(re.sub(r"_all$", "", stem)) if ext == ".csv" else _notion_id(stem)
        digest = content_digest(raw)
        plan.props = {"original_filename": posixpath.basename(e.path), "markdown_import": digest}
        if notion_id:
            plan.props["notion_id"] = notion_id
            report["notion"] = True
        plan.folder = _dir_folder(e.path)
        if ext == ".csv":
            plan.title = clean_segment(_clean_stem(re.sub(r"_all$", "", stem)))[:500] or "Database"
            plan.body = _csv_to_markdown(raw)
        else:
            try:
                text = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                warn(e.path, "not UTF-8")
                continue
            fm, body = parse_frontmatter(text)
            title, body = _take_title(body, fm.get("title") or None)
            plan.title = (title or _clean_stem(stem)).strip()[:500] or "Untitled note"
            if fm.get("folder") is not None:
                plan.folder = clean_path(fm["folder"])
            bibtex, body = _take_bibtex(body)
            if bibtex:
                plan.props["bibtex"] = bibtex
            if any(fm.get(k) for k in ("doi", "authors", "year")):
                plan.props["meta"] = {
                    "title": plan.title, "doi": fm.get("doi", ""),
                    "authors": [a.strip() for a in fm.get("authors", "").split(",") if a.strip()],
                    "year": fm.get("year", ""), "source": "manual",
                }
            if fm.get("source"):
                plan.props["_source"] = fm["source"]
            plan.body = _convert_asides(body)
        plan.folder = clean_path("/".join(p for p in (prefix, plan.folder) if p))
        existing = by_digest.get(digest) or (by_notion.get(notion_id) if notion_id else None)
        if existing:
            plan.existing = True
            plan.page_id = existing
        plans.append(plan)
        targets[e.path] = plan.page_id
    for path, db_entry in csv_alias.items():
        if db_entry.path in targets:
            targets[path] = targets[db_entry.path]

    stored = {}

    def store_asset(path):
        """Upload a bundled file once; None when it can't be (type, limits)."""
        if path in stored:
            return stored[path]
        url = None
        entry = assets.get(path)
        if entry is not None:
            ext = _split_ext(path)[1]
            data = entry.read()
            if ext == ".pdf" and not is_pdf(data):
                warn(path, "not a valid PDF")
            else:
                try:
                    filename, _ = store_file(ws, data, ext)
                    url = f"/api/uploads/{filename}"
                    report["assets_stored"] += 1
                except HTTPException as exc:
                    warn(path, str(exc.detail))
        stored[path] = url
        return url

    def resolve(base_dir, href):
        """A relative link target → the zip path it names, or None."""
        if not href or _SCHEME_RE.match(href) or href.startswith(("#", "/")):
            return None
        target = re.split(r"[#?]", href, maxsplit=1)[0]
        for cand in dict.fromkeys((unquote(target), target)):
            full = posixpath.normpath(posixpath.join(base_dir, cand) if base_dir else cand)
            full = unicodedata.normalize("NFC", full)
            if full in targets or full in assets:
                return full
        return None

    def rewrite_links(body, base_dir):
        def repl(m):
            bang, label, href, title = m.groups()
            path = resolve(base_dir, href.strip("<>").strip())
            if path is None:
                return m.group(0)
            if path in targets:
                report["links_resolved"] += 1
                return f"[[{targets[path]}]]"
            url = store_asset(path)
            if not url:
                return m.group(0)
            return f"{bang}[{label}]({url}{title})"
        return _LINK_RE.sub(repl, body)

    for plan in plans:
        if plan.existing:
            report["pages_skipped"] += 1
            continue
        base_dir = posixpath.dirname(plan.entry.path)
        source = plan.props.pop("_source", None)
        if source:
            path = resolve(base_dir, source)
            if path and _split_ext(path)[1] == ".pdf":
                url = store_asset(path)
                if url:
                    plan.props["doc_id"] = url.rsplit("/", 1)[1][:-4]
                    plan.props["source_url"] = url
            elif _SCHEME_RE.match(source) and source.lower().startswith(("http://", "https://")):
                plan.props["source_url"] = source
        if plan.folder:
            plan.props["folder"] = plan.folder
        tree = md_to_blocks(rewrite_links(plan.body, base_dir)) if plan.body.strip() else []
        report["blocks_imported"] += insert_note_page(conn, plan.page_id, plan.title, plan.props, tree, now)
        report["pages_created"] += 1
        if len(report["pages"]) < 200:
            report["pages"].append({"id": plan.page_id, "title": plan.title, "folder": plan.folder})

    for inner in opened:
        inner.close()
    log.info(f"[markdown-zip] {report['pages_created']} pages, {report['pages_skipped']} skipped, "
             f"{report['assets_stored']} files, {report['links_resolved']} links"
             f"{' (Notion)' if report['notion'] else ''}")
    return report
