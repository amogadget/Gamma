"""Import a zip of Markdown notes as pages — Notion's "Markdown & CSV" export,
an Obsidian vault, Gamma's own Markdown export, or any zipped folder of
``.md`` files. One logic serves all of them, because they only differ in
naming and link conventions:

- every ``.md`` becomes a note page; its title is the front-matter ``title``,
  else the leading ``# H1``, else the filename (Notion's ``Title <32-hex id>``
  suffix stripped). In an Obsidian vault the filename IS the title, so there
  the H1 stays in the body unless it repeats the title;
- directories become folder labels (Notion puts a page's subpages in a folder
  named after the page, so the page tree becomes the folder tree); a
  front-matter ``folder:`` (what Gamma's export writes, relative to the
  exported folder) wins over the directory; the caller's ``folder`` prefix
  goes in front of both;
- links to other notes in the zip become ``[[page]]`` mentions — Markdown
  links (relative paths, Notion's percent-encoded ones) and Obsidian
  wikilinks alike, both resolved by path first and by basename anywhere in
  the zip second, case-insensitively, the way Obsidian resolves them.
  ``[[Note#Heading]]`` and ``[[Note#^id]]`` point at that heading / anchored
  block, ``![[Note#^id]]`` becomes a synced block, whole-note and section
  embeds degrade to mentions (a Gamma embed shows one block), and the
  ``^id`` anchors themselves are removed from the text;
- links and embeds of bundled images / PDFs / files upload the file
  (content-hash dedup, storage limits per file) and point at
  ``/api/uploads/…``; an Obsidian image embed's ``|300`` size becomes the
  ``![alt|300](url)`` form the editor renders;
- Obsidian properties: ``tags`` become labels (``properties.category``),
  ``aliases`` are kept in ``properties.aliases``; foldable callout markers
  are dropped; ``%%comments%%`` are removed (vaults only — the ``.obsidian/``
  folder marks one); ``.obsidian/``, ``.trash/`` and ``.canvas`` files are
  skipped;
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
from .db import page_now
from .foldertags import clean_path, clean_segment
from .logbuf import log
from .markdown_import import MAX_MARKDOWN_BYTES, fm_list, fm_text, md_to_blocks, parse_frontmatter
from .storage import IMAGE_MEDIA_TYPES, content_digest, is_pdf, store_file, upload_media_type

MAX_PAGES = 2000
MAX_TOTAL_BYTES = 1 << 30        # uncompressed, across nested zips
MAX_NESTED_ZIPS = 50
MAX_TABLE_ROWS = 500
MAX_TABLE_COLS = 40

_MD_EXTS = (".md", ".markdown")
_NOTION_ID_RE = re.compile(r"\s+[0-9a-f]{32}$", re.I)
_EXPORT_WRAPPER_RE = re.compile(r"^Export-[0-9a-f-]{8,}$", re.I)
_H1_RE = re.compile(r"^#\s+(.+?)\s*#*\s*$")
_HEADING_TEXT_RE = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$")
_BIBTEX_RE = re.compile(r"^```bibtex[ \t]*\n(.*?)\n```[ \t]*\n?", re.S)
_ASIDE_RE = re.compile(r"<aside>\s*(.*?)\s*</aside>", re.S)
# [label](target "title") / ![alt](target) — label may hold one level of []
_LINK_RE = re.compile(r"(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^)\s]+)((?:\s+\"[^\"]*\")?)\s*\)")
# [[target#sub#sub|alias]] / ![[…]] — Obsidian's wikilink and embed; the
# alias pipe may be escaped (``\|``) inside a table cell. The same shape
# matches Gamma's own [[id]] refs, which simply resolve to nothing here.
_WIKILINK_RE = re.compile(r"(!?)\[\[([^\[\]|#]*)((?:#[^\[\]|]*)*)(?:\\?\|([^\[\]]*))?\]\]")
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
# Bundled files that become uploads: anything Gamma would accept from
# POST /api/upload-file (not executable, well-formed extension) that is not
# a note or a canvas.
_NOT_ASSET_EXTS = {".canvas", ""}


def _is_asset_ext(ext: str) -> bool:
    return ext not in _MD_EXTS and ext not in _NOT_ASSET_EXTS and upload_media_type(ext) is not None
# Obsidian block anchors: `` ^id`` at the end of a line, or ``^id`` alone on
# a line after a list / quote / table / fence.
_ANCHOR_END_RE = re.compile(r"[ \t]+\^([A-Za-z0-9-]+)[ \t]*$")
_ANCHOR_LINE_RE = re.compile(r"^\^([A-Za-z0-9-]+)$")
_IMAGE_SIZE_RE = re.compile(r"^\d+(?:x\d+)?$")
_FENCE_LINE_RE = re.compile(r"^[ \t]*(```|~~~)")
_COMMENT_RE = re.compile(r"%%.*?%%", re.S)
_SKIP_DIRS = {".obsidian", ".trash"}


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


def _norm_heading(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


# --- body preparation --------------------------------------------------------

def _take_title(body: str, fm_title, vault_stem=None):
    """The title and the body without its title line. Outside a vault a
    leading ``# H1`` is the title when there is no front-matter title or it
    repeats it — Notion and Gamma both write one. In a vault the filename
    (``vault_stem``) is the title unless the front matter says otherwise, and
    the H1 is only stripped when it repeats that title."""
    lines = body.lstrip("\n").split("\n")
    m = _H1_RE.match(lines[0]) if lines else None
    if not m:
        return fm_title or vault_stem, body
    h1 = m.group(1).strip()
    if vault_stem is not None:
        title = fm_title or vault_stem
        if h1.casefold() != title.casefold():
            return title, body
        return title, "\n".join(lines[1:]).lstrip("\n")
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


def _strip_comments(body: str) -> str:
    """Remove Obsidian ``%%…%%`` comments (inline or block) outside fences."""
    out, run, in_fence = [], [], False

    def flush():
        if run:
            out.append(_COMMENT_RE.sub("", "\n".join(run)))
            run.clear()

    for line in body.split("\n"):
        if _FENCE_LINE_RE.match(line):
            flush()
            out.append(line)
            in_fence = not in_fence
        elif in_fence:
            out.append(line)
        else:
            run.append(line)
    flush()
    return "\n".join(out)


def _wiki_source(value: str) -> str:
    """A front-matter ``source: "[[paper.pdf]]"`` → ``paper.pdf``."""
    m = re.match(r"^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$", value.strip())
    return m.group(1).strip() if m else value.strip()


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


# --- the block tree: ids, anchors, headings ----------------------------------

def _prepare_tree(nodes, anchors, headings):
    """Give every node an id, take Obsidian ``^id`` anchors out of the text
    (``anchors``: marker → block id; an anchor on its own line belongs to the
    block before it) and index heading texts (``headings``: normalized text →
    block id, first wins) so ``[[Note#…]]`` links can target blocks."""
    kept = []
    for node in nodes:
        content = node.get("content", "")
        alone = _ANCHOR_LINE_RE.match(content.strip())
        if alone and kept and not node.get("children"):
            anchors.setdefault(alone.group(1).lower(), kept[-1]["id"])
            continue
        node["id"] = secrets.token_urlsafe(9)
        lines = content.split("\n")
        if len(lines) > 1 and _ANCHOR_LINE_RE.match(lines[-1].strip()):
            anchors.setdefault(lines[-1].strip()[1:].lower(), node["id"])
            lines.pop()
        for idx in {len(lines) - 1, 0}:
            m = _ANCHOR_END_RE.search(lines[idx])
            if m:
                anchors.setdefault(m.group(1).lower(), node["id"])
                lines[idx] = lines[idx][:m.start()]
        node["content"] = "\n".join(lines).strip("\n")
        hm = _HEADING_TEXT_RE.match(node["content"].split("\n")[0])
        if hm:
            headings.setdefault(_norm_heading(hm.group(1)), node["id"])
        node["children"] = _prepare_tree(node.get("children") or [], anchors, headings)
        kept.append(node)
    return kept


def _walk(nodes):
    for node in nodes:
        yield node
        yield from _walk(node.get("children") or [])


# --- storing -----------------------------------------------------------------

def markdown_page(conn, raw: bytes, original: str, folder: str = "") -> dict:
    """One Markdown file → a note page: title from front matter else the file
    name, blocks from the body, filed under ``folder`` then a front-matter
    ``folder:`` below it (what Gamma's own export writes). The page records
    ``markdown_import`` = the content hash of ``raw`` — the same digest a
    stored upload of the file is named by, which is how a file chip finds
    the page made from it. Commits. Raises HTTPException 413/400 for an
    oversized or non-UTF-8 file. Shared by POST /import/markdown (a fresh
    upload) and POST /pages/from-file (a stored one)."""
    if len(raw) > MAX_MARKDOWN_BYTES:
        raise HTTPException(status_code=413, detail="Markdown file exceeds 5 MB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Markdown file must be UTF-8")
    fields, body = parse_frontmatter(text)
    fallback = re.sub(r"\.(?:md|markdown)$", "", original, flags=re.I).strip() or "Untitled note"
    title = (fm_text(fields, "title") or fallback).strip()[:500]
    tree = md_to_blocks(body)
    clean_folder = clean_path("/".join(p for p in (folder, fm_text(fields, "folder")) if p))
    props = {"original_filename": original, "markdown_import": content_digest(raw)}
    if clean_folder:
        props["folder"] = clean_folder
    now = page_now()
    page_id = secrets.token_urlsafe(9)
    imported = insert_note_page(conn, page_id, title, props, tree, now)
    conn.commit()
    return {"block_id": page_id, "title": title, "original_filename": original,
            "imported": imported, "folder": clean_folder}


def insert_note_page(conn, page_id, title, props, tree, now) -> int:
    """Insert a root page (last on root) plus its ``{content, children}``
    tree (a node's own ``id`` is honoured); returns the number of note blocks
    written."""
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
            child_id = node.get("id") or secrets.token_urlsafe(9)
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
    __slots__ = ("entry", "page_id", "title", "folder", "body", "props", "existing",
                 "tree", "anchors", "headings")

    def __init__(self, entry):
        self.entry = entry
        self.page_id = secrets.token_urlsafe(9)
        self.title = ""
        self.folder = ""
        self.body = ""
        self.props = {}
        self.existing = False
        self.tree = []
        self.anchors = {}
        self.headings = {}


def import_markdown_zip(ws: str, zf: zipfile.ZipFile, conn, folder: str = "",
                        now: str = "") -> dict:
    """Import every note in ``zf`` into workspace ``ws`` through the open ``pages.db``
    connection (the caller commits). Returns the report dict."""
    prefix = clean_path(folder)
    entries, opened = [], []
    _walk_zip(zf, "", entries, {"bytes": 0}, opened)
    _strip_wrappers(entries)
    report = {"pages_created": 0, "pages_skipped": 0, "blocks_imported": 0,
              "assets_stored": 0, "links_resolved": 0, "notion": False, "obsidian": False,
              "pages": [], "warnings": []}

    def warn(title, reason):
        if len(report["warnings"]) < 200:
            report["warnings"].append({"title": title, "reason": reason})

    # An Obsidian vault carries its settings folder; the folder itself (and
    # the vault's trash) holds no notes.
    vault = any(".obsidian" in e.path.split("/") for e in entries)
    report["obsidian"] = vault
    entries = [e for e in entries if not (set(e.path.split("/")[:-1]) & _SKIP_DIRS)]
    for e in entries:
        if _split_ext(e.path)[1] == ".canvas":
            warn(e.path, "Obsidian canvas files are not imported")

    notes = sorted((e for e in entries if _split_ext(e.path)[1] in _MD_EXTS),
                   key=lambda e: (e.path.count("/"), e.path.lower()))
    csvs = [e for e in entries if _split_ext(e.path)[1] == ".csv"]
    assets = {e.path: e for e in entries if _is_asset_ext(_split_ext(e.path)[1])}
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

    plans, targets, plan_of = [], {}, {}
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
            title, body = _take_title(body, fm_text(fm, "title") or None,
                                      vault_stem=_clean_stem(stem) if vault else None)
            plan.title = (title or _clean_stem(stem)).strip()[:500] or "Untitled note"
            if fm.get("folder") is not None:
                plan.folder = clean_path(fm_text(fm, "folder"))
            bibtex, body = _take_bibtex(body)
            if bibtex:
                plan.props["bibtex"] = bibtex
            if any(fm.get(k) for k in ("doi", "authors", "year")):
                plan.props["meta"] = {
                    "title": plan.title, "doi": fm_text(fm, "doi"),
                    "authors": fm_list(fm, "authors"),
                    "year": fm_text(fm, "year"), "source": "manual",
                }
            if fm_text(fm, "source"):
                plan.props["_source"] = _wiki_source(fm_text(fm, "source"))
            # Obsidian's built-in properties (and their pre-1.9 singular
            # names): tags are labels, aliases ride along.
            tags = [t.lstrip("#").replace(",", " ").strip()
                    for t in fm_list(fm, "tags") + fm_list(fm, "tag")]
            tags = [t for t in tags if t]
            if tags:
                plan.props["category"] = ", ".join(dict.fromkeys(tags))
            aliases = [a for a in fm_list(fm, "aliases") + fm_list(fm, "alias") if a]
            if aliases:
                plan.props["aliases"] = list(dict.fromkeys(aliases))
            if vault:
                body = _strip_comments(body)
            plan.body = _convert_asides(body)
        plan.folder = clean_path("/".join(p for p in (prefix, plan.folder) if p))
        existing = by_digest.get(digest) or (by_notion.get(notion_id) if notion_id else None)
        if existing:
            plan.existing = True
            plan.page_id = existing
        elif plan.body.strip():
            plan.tree = _prepare_tree(md_to_blocks(plan.body), plan.anchors, plan.headings)
        plans.append(plan)
        targets[e.path] = plan.page_id
        plan_of[plan.page_id] = plan
    for path, db_entry in csv_alias.items():
        if db_entry.path in targets:
            targets[path] = targets[db_entry.path]

    # Basename lookup, the way Obsidian resolves a bare [[Note]] or
    # ![[image.png]] wherever the file sits: lower-cased stem (notes) or
    # filename (assets) → zip paths.
    notes_by_stem, assets_by_name, by_lower = {}, {}, {}
    for path in targets:
        by_lower[path.lower()] = path
        notes_by_stem.setdefault(_split_ext(path)[0].lower(), []).append(path)
    for path in assets:
        by_lower[path.lower()] = path
        assets_by_name.setdefault(posixpath.basename(path).lower(), []).append(path)

    def nearest(base_dir, paths):
        same = [p for p in paths if posixpath.dirname(p) == base_dir]
        return min(same or paths, key=lambda p: (p.count("/"), p.lower()))

    def resolve(base_dir, href):
        """A link target → the zip path it names, or None. Relative to the
        note first (Markdown links), then by exact vault path, then by
        basename anywhere (wikilinks, "shortest path" Markdown links)."""
        if not href or _SCHEME_RE.match(href) or href.startswith(("#", "/")):
            return None
        target = re.split(r"[#?]", href, maxsplit=1)[0].strip()
        if not target:
            return None
        cands = list(dict.fromkeys((unquote(target), target)))
        for cand in cands:
            cand = unicodedata.normalize("NFC", cand)
            for full in (posixpath.normpath(posixpath.join(base_dir, cand)) if base_dir else cand,
                         posixpath.normpath(cand)):
                for variant in (full, full + ".md"):
                    hit = by_lower.get(variant.lower())
                    if hit:
                        return hit
        for cand in cands:
            leaf = unicodedata.normalize("NFC", posixpath.basename(cand)).lower()
            stem, ext = _split_ext(leaf)
            paths = (notes_by_stem.get(stem) if ext in _MD_EXTS or not ext else None) \
                or notes_by_stem.get(leaf) or assets_by_name.get(leaf)
            if paths:
                return nearest(base_dir, paths)
        return None

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

    def block_target(page_id, sub):
        """``#Heading`` / ``#^id`` inside a link to ``page_id`` → the block it
        names, else the page itself."""
        plan = plan_of.get(page_id)
        last = sub.split("#")[-1].strip() if sub else ""
        if plan is None or not last:
            return page_id
        if last.startswith("^"):
            return plan.anchors.get(last[1:].lower(), page_id)
        return plan.headings.get(_norm_heading(last), page_id)

    def rewrite_links(body, base_dir, page_id):
        def md_repl(m):
            bang, label, href, title = m.groups()
            href = href.strip("<>").strip()
            path = resolve(base_dir, href)
            if path is None:
                return m.group(0)
            if path in targets:
                report["links_resolved"] += 1
                sub = unquote(href.partition("#")[2])
                return f"[[{block_target(targets[path], '#' + sub if sub else '')}]]"
            url = store_asset(path)
            if not url:
                return m.group(0)
            return f"{bang}[{label}]({url}{title})"

        def wiki_repl(m):
            bang, target, sub, alias = m.groups()
            target = target.strip()
            if target:
                path = resolve(base_dir, target)
            else:
                path = None if not sub else "#self"      # [[#Heading]] — this note
            if path is None:
                return m.group(0)
            if path == "#self" or path in targets:
                report["links_resolved"] += 1
                pid = page_id if path == "#self" else targets[path]
                bid = block_target(pid, sub)
                # An embed of one anchored block is a synced block; a whole
                # note or a section has no single block to sync (a Gamma
                # embed shows one block), so those are mentions.
                anchored = sub.split("#")[-1].startswith("^") and bid != pid
                return f"![[{bid}]]" if bang and anchored else f"[[{bid}]]"
            url = store_asset(path)
            if not url:
                return m.group(0)
            leaf = posixpath.basename(path)
            alias = (alias or "").strip()
            if bang and _split_ext(path)[1] in IMAGE_MEDIA_TYPES:
                size = alias if _IMAGE_SIZE_RE.match(alias) else ""
                alt = "" if size else alias
                return f"![{alt}|{size}]({url})" if size else f"![{alt}]({url})"
            return f"[{alias or leaf}]({url})"

        return _LINK_RE.sub(md_repl, _WIKILINK_RE.sub(wiki_repl, body))

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
        for node in _walk(plan.tree):
            node["content"] = rewrite_links(node["content"], base_dir, plan.page_id)
        report["blocks_imported"] += insert_note_page(conn, plan.page_id, plan.title, plan.props,
                                                      plan.tree, now)
        report["pages_created"] += 1
        if len(report["pages"]) < 200:
            report["pages"].append({"id": plan.page_id, "title": plan.title, "folder": plan.folder})

    for inner in opened:
        inner.close()
    log.info(f"[markdown-zip] {report['pages_created']} pages, {report['pages_skipped']} skipped, "
             f"{report['assets_stored']} files, {report['links_resolved']} links"
             f"{' (Notion)' if report['notion'] else ''}{' (Obsidian vault)' if vault else ''}")
    return report
