"""Exporting pages: one driver (``_run_export``) walks the selected page
subtrees and feeds them to the format's ``_Builder`` — Markdown, a Logseq
graph, a Zotero RDF library, a scoped Gamma backup, or the notes typeset as a
PDF document. Most builders produce a zip; a bare .md (nothing to bundle) and
the notes PDF are single files."""

import base64
import json
import os
import re
import sqlite3
import tempfile
import zipfile
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from .. import ink as inkmod
from ..auth import resolve_ws, share_scope_page
from ..blocks_store import BLOCK_COLUMNS, assert_block_in_page, block_to_dict, fetch_subtree
from ..db import connect_pages_db
from ..db import (
    PAGES_SCHEMA,
    connect_data_db,
    page_now,
    pdf_upload_path,
    safe_doc_id,
    ws_uploads_dir,
)
from ..logseq_graph_export import (
    CONFIG_EDN,
    collect_highlights,
    render_area_images,
    render_edn,
    render_graph_page_md,
    render_hls_md,
)
from ..markdown_export import (
    UPLOAD_RE,
    build_tree,
    collect_and_rewrite,
    render_readable,
    slugify,
)
from ..logbuf import log
from ..obsidian_export import APP_JSON, VaultContext, referenced_blocks, render_vault_page
from ..pdf_document import absolute_asset_link, render_document
from ..pdf_export import (
    annotate_pdf,
    annotate_pdf_result,
    highlight_note_text,
    native_ink_picture,
)
from ..pdf_notes import render_notes
from ..zotero_export import (
    IMAGE_MIME,
    MD_IMAGE_RE,
    build_rdf,
    highlight_memo_html,
    note_html,
    strip_image_md,
)

router = APIRouter(prefix="/api", tags=["export"])


def _content_disposition(filename: str) -> str:
    """attachment header carrying both an ASCII fallback and a UTF-8 name."""
    ascii_name = filename.encode("ascii", "ignore").decode() or "export"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def _link_base(request: Request) -> str:
    """The origin an exported document's links must carry.

    A downloaded PDF has no origin of its own, so the notes document writes
    absolute URLs. ``GAMMA_PUBLIC_URL`` wins when the deployment sets a
    canonical one (the same knob the MCP/OAuth endpoints advertise by); else
    the request's own base, which already includes a deployment's root path
    prefix (``request.base_url`` is built from the app root path)."""
    return (os.environ.get("GAMMA_PUBLIC_URL", "").strip().rstrip("/")
            or str(request.base_url).rstrip("/"))


def _md_response(md: str, slug: str) -> Response:
    return Response(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": _content_disposition(f"{slug}.md")},
    )


def _zip_response(entries, assets, uploads_dir, download_name: str, files=(), blobs=()) -> FileResponse:
    """entries: list of (arcname, text). assets: set of upload filenames, written
    once under assets/ (deduped by content-addressed name). files: (arcname,
    disk path) pairs; blobs: (arcname, bytes) pairs."""
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
            for arcname, text in entries:
                z.writestr(arcname, text)
            for filename in sorted(assets):
                path = uploads_dir / filename
                if path.is_file():
                    z.write(path, f"assets/{filename}")
            for arcname, path in files:
                if path.is_file():
                    z.write(path, arcname)
            for arcname, data in blobs:
                z.writestr(arcname, data)
    except Exception:
        os.unlink(tmp.name)
        raise
    return FileResponse(
        tmp.name,
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(download_name)},
        background=BackgroundTask(os.unlink, tmp.name),
    )


def _graph_page_parts(page, uploads_dir, include_pdf):
    """One page in Logseq file-graph layout → (text entries, disk files,
    blobs, image-asset names). The PDF is renamed sha → page stem so the
    ``hls__<stem>`` page / ``<stem>.edn`` / ``<stem>.pdf`` naming convention
    Logseq's annotation system keys on actually holds. Spaces are replaced so
    inline ``![](../assets/<stem>.pdf)`` links stay valid Markdown."""
    stem = slugify(page.get("content"), page["id"]).replace(" ", "_")
    doc_id = (page.get("properties") or {}).get("doc_id")
    pdf_path = None
    if doc_id:
        try:
            pdf_path = uploads_dir / f"{safe_doc_id(doc_id)}.pdf"
        except ValueError:
            pdf_path = None
    has_pdf = bool(include_pdf and pdf_path and pdf_path.is_file())

    md, assets = collect_and_rewrite(
        render_graph_page_md(page, stem, has_pdf), include_pdf=False, prefix="../assets/"
    )
    entries = [(f"pages/{stem}.md", md)]
    files, blobs = [], []
    if has_pdf:
        highlights = collect_highlights(page)
        entries.append((f"pages/hls__{stem}.md", render_hls_md(stem, highlights)))
        entries.append((f"assets/{stem}.edn", render_edn(highlights)))
        files.append((f"assets/{stem}.pdf", pdf_path))
        blobs.extend(render_area_images(pdf_path, stem, highlights))
    return entries, files, blobs, assets


def _children_by_id(blocks) -> dict:
    """``{parent_id: [children in sibling order]}`` — what highlight_note_text
    walks for an annotation's nested notes."""
    children_by_id: dict = {}
    for b in sorted(blocks, key=lambda b: b["position"] or ""):
        children_by_id.setdefault(b["parent_id"], []).append(b)
    return children_by_id


def _collect_marks(blocks) -> list[dict]:
    """Highlight blocks → annotate_pdf marks (position/color/popup note).
    Skips annotations that came from the PDF itself and are STILL embedded in
    it (annot_stripped marks ones the import removed from the file), and link
    regions (Gamma navigation aids, not annotations)."""
    children_by_id = _children_by_id(blocks)
    marks = []
    for b in blocks:
        props = b["properties"]
        if not props.get("highlight_id") or not props.get("pdf_position"):
            continue
        if props.get("imported_annot") and not props.get("annot_stripped"):
            continue
        if props.get("link_url") or props.get("link_page_id"):
            continue
        marks.append({
            "position": props["pdf_position"],
            "color": props.get("color"),
            "note": highlight_note_text(b, children_by_id),
            # For /Square annotations: the deterministic /NM key Zotero
            # requires before it will import an area annotation.
            "id": props["highlight_id"],
        })
    return marks


def _collect_ink(blocks, uploads_dir) -> list[dict]:
    """Handwriting blocks → ``annotate_pdf``'s ink groups (the parsed file,
    the caption + nested notes, the block id). Same skip rule as marks for
    ink that came from the PDF and is still embedded in it."""
    children_by_id = _children_by_id(blocks)
    groups = []
    for b in blocks:
        props = b["properties"]
        url = props.get("ink_url")
        if not url or (props.get("imported_annot") and not props.get("annot_stripped")):
            continue
        ink_file = inkmod.read_upload(uploads_dir, url)
        if not ink_file:
            continue
        groups.append({"ink": ink_file, "note": highlight_note_text(b, children_by_id), "id": b["id"]})
    return groups


def _collect_native_ink(blocks, uploads_dir) -> list[dict]:
    """Native (iPad) ``pdf_ink`` blocks → ``annotate_pdf``'s native ink groups
    (the readable picture, the block's properties and its id).

    The iPad's editable source is Apple's private PKDrawing, which nothing on
    this server can draw or convert to strokes, so the picture comes from one
    of the two renderings the iPad already uploaded: the block's PNG preview
    (the whole annotation, which is what the viewer puts on the page, at the
    block's own bounds) or — when the preview is missing or unreadable — the
    per-stroke ``.inkjson`` derivative. A block with neither is left out and
    logged rather than drawn from a guess.

    No ``imported_annot`` skip rule here: unlike `ink_url` blocks, a native
    annotation is never read out of the PDF's own annotations, so there is no
    double-drawing case to avoid."""
    groups = []
    for b in blocks:
        props = b["properties"]
        if props.get("type") != "pdf_ink":
            continue
        picture = native_ink_picture(uploads_dir, props)
        if not picture:
            log.info(f"native ink {b['id']}: no readable preview or replay derivative; not exported")
            continue
        groups.append({"props": props, "picture": picture, "id": b["id"]})
    return groups


# Pasted images above this size stay attachments only — a data URI this big
# would bloat the note beyond what Zotero's editor handles gracefully.
_EMBED_IMAGE_CAP = 4_000_000


def _walk_tree(node):
    yield node
    for child in node.get("children") or []:
        yield from _walk_tree(child)


def _image_resolver(uploads_dir):
    """``resolve_image`` for note_html: upload filename → (mime, base64)."""
    def resolve(filename):
        mime = IMAGE_MIME.get(filename.rsplit(".", 1)[-1].lower())
        path = uploads_dir / filename
        if not mime or not path.is_file() or path.stat().st_size > _EMBED_IMAGE_CAP:
            return None
        return mime, base64.b64encode(path.read_bytes()).decode("ascii")
    return resolve


# --- format builders --------------------------------------------------------
# One export = one builder. The driver (_run_export) walks the selected pages
# exactly once — subtree fetch, tree build, progress bookkeeping — and feeds
# each page to the mode's builder; the builder accumulates zip parts and names
# the download. Adding an export format = adding a builder here; the
# endpoints, the progress plumbing and _zip_response stay untouched.

class _Builder:
    """opts: {"pdf": bool, "highlights": bool, "notes": bool,
    "folder_scope": path | None}."""
    suffix = ".zip"  # appended to the base slug for the download name

    def __init__(self, ws, base: str, opts: dict):
        self.ws = ws
        self.base = base
        self.opts = opts
        self.uploads_dir = ws_uploads_dir(ws)
        self.entries, self.assets = [], set()
        self.files, self.blobs = [], []
        # The public origin this export should write absolute links against
        # (_link_base); only the notes PDF emits local references as links.
        self.link_base = ""

    def begin(self, conn, root_ids):
        """Sees the whole export set before any page is walked (the request's
        DB connection is only open during the walk, not in ``response``)."""

    def add_page(self, n: int, rows, page):
        raise NotImplementedError

    def finish(self):
        """Last chance to add whole-export parts (config files, the RDF…)."""

    def response(self) -> FileResponse:
        self.finish()
        return _zip_response(self.entries, self.assets, self.uploads_dir,
                             f"{self.base}{self.suffix}", self.files, self.blobs)

    def render_ink_svgs(self, page_assets, prefix="assets/"):
        """Handwriting pictures for a rendered page: the Markdown names a
        ``<stem>.svg`` next to each ``<stem>.ink`` upload (``ink_svg_name``);
        no such file exists, so it is generated here as a zip blob."""
        for name in page_assets:
            if not name.endswith(".svg"):
                continue
            source = self.uploads_dir / (name[:-4] + ".ink")
            arc = f"{prefix}{name}"
            if not source.is_file() or (self.uploads_dir / name).is_file() \
                    or any(b[0] == arc for b in self.blobs):
                continue
            try:
                svg = inkmod.to_svg(inkmod.parse_ink(source.read_bytes()))
            except (inkmod.InkError, OSError):
                continue
            self.blobs.append((arc, svg.encode("utf-8")))


class _MarkdownBuilder(_Builder):
    """One readable .md per page plus a shared assets/ folder (deduped by
    content-hash filename). [[refs]], ![[embeds]] and internal document links
    resolve against the export set: a target page that is part of the same
    export is linked by relative filename, so the zip is self-contained."""

    def __init__(self, ws, base, opts):
        super().__init__(ws, base, opts)
        self.used = set()
        self.filenames = {}          # page id → arcname inside the zip
        self.resolve_ref = None

    def begin(self, conn, root_ids):
        # Every page's filename up front, so cross-page links can be written
        # while the first page renders.
        for rid in root_ids:
            row = conn.execute("SELECT content FROM unified_blocks WHERE id = ?",
                               (rid,)).fetchone()
            if row is None:
                continue
            slug = slugify(row[0], rid)
            arcname = f"{slug}.md"
            # id suffix makes collisions near-impossible, but guard anyway.
            while arcname in self.used:
                arcname = f"{slug}-{len(self.used)}.md"
            self.used.add(arcname)
            self.filenames[rid] = arcname
        self.resolve_ref = _block_ref_resolver(conn)

    def add_page(self, n, rows, page):
        md, page_assets = collect_and_rewrite(
            render_readable(page, highlights=self.opts["highlights"], notes=self.opts["notes"],
                            resolve_ref=self.resolve_ref, page_file=self.filenames.get,
                            folder_scope=self.opts.get("folder_scope")),
            include_pdf=self.opts["pdf"])
        self.assets |= page_assets
        self.render_ink_svgs(page_assets)
        arcname = self.filenames.get(page["id"]) \
            or f"{slugify(page.get('content'), page['id'])}.md"
        self.entries.append((arcname, md))


class _ObsidianBuilder(_Builder):
    """An Obsidian vault (``obsidian_export``): ``<dir>/<Title>.md`` per page
    (directories = folder labels relative to the exported folder),
    ``attachments/`` with the images and — with the bundle switch — the PDFs
    named after their page, wikilinks / ``^id`` anchors resolved against the
    export set, and an ``.obsidian/app.json`` that marks the folder as a
    vault (the importer reads it back as one)."""
    suffix = "-obsidian.zip"

    def __init__(self, ws, base, opts):
        super().__init__(ws, base, opts)
        self.ctx = None

    def begin(self, conn, root_ids):
        self.ctx = VaultContext(_block_ref_resolver(conn), include_pdf=self.opts["pdf"])
        pages = []
        for rid in root_ids:
            row = conn.execute("SELECT content, properties FROM unified_blocks WHERE id = ?",
                               (rid,)).fetchone()
            if row is None:
                continue
            try:
                props = json.loads(row[1] or "{}")
            except (TypeError, ValueError):
                props = {}
            pages.append((rid, row[0] or "", props.get("folder") or ""))
        self.ctx.name_pages(pages, self.opts.get("folder_scope"))
        # Every block that something links to needs its ^anchor written, and
        # a page may be rendered before the page that links into it — so the
        # link-bearing blocks are scanned up front (links from outside the
        # export only add harmless anchors).
        texts = (r[0] for r in conn.execute(
            "SELECT content FROM unified_blocks WHERE content LIKE '%[[%'"))
        referenced_blocks(texts, self.ctx)
        if self.opts["pdf"]:
            for rid, title, _ in pages:
                self._bundle_pdf(conn, rid, title)

    def _bundle_pdf(self, conn, rid, title):
        row = conn.execute("SELECT properties FROM unified_blocks WHERE id = ?", (rid,)).fetchone()
        try:
            doc_id = json.loads(row[0] or "{}").get("doc_id") if row else None
            path = pdf_upload_path(self.ws, doc_id) if doc_id else None
        except (TypeError, ValueError):
            path = None
        if path and path.is_file():
            arcname = self.ctx.name_pdf(rid, title, doc_id)
            if all(f[0] != arcname for f in self.files):
                self.files.append((arcname, path))

    def add_page(self, n, rows, page):
        md, page_assets = collect_and_rewrite(
            render_vault_page(page, self.ctx, highlights=self.opts["highlights"],
                              notes=self.opts["notes"]),
            include_pdf=self.opts["pdf"], prefix="attachments/")
        self.assets |= page_assets
        self.entries.append((self.ctx.page_file[page["id"]], md))

    def finish(self):
        # Attachments live in attachments/, not the readable export's assets/.
        self.files += [(f"attachments/{name}", self.uploads_dir / name)
                       for name in sorted(self.assets)]
        self.assets = set()
        self.entries.append((".obsidian/app.json", APP_JSON))


class _LogseqBuilder(_Builder):
    """A Logseq file graph: pages/ + assets/ + logseq/config.edn, highlights
    as native hls__ pages + EDN (see _graph_page_parts)."""
    suffix = "-logseq.zip"

    def add_page(self, n, rows, page):
        p_entries, p_files, p_blobs, p_assets = _graph_page_parts(
            page, self.uploads_dir, self.opts["pdf"])
        self.entries += p_entries
        self.files += p_files
        self.blobs += p_blobs
        self.assets |= p_assets

    def finish(self):
        self.entries.append(("logseq/config.edn", CONFIG_EDN))


class _ZoteroBuilder(_Builder):
    """A Zotero RDF library: ``<base>/<base>.rdf`` + ``<base>/files/<n>/…``.
    Highlights travel embedded inside the PDF copies (annotate_pdf — Zotero's
    "Include Annotations" convention), notes become bib:Memo items with pasted
    images embedded as data URIs, folder labels (confined to the exported
    folder) the collection tree. Images referenced anywhere in a page also
    ride as item attachments; annotation comments carry a plain "(image: …)"
    placeholder since they can't hold pictures."""
    suffix = "-zotero.zip"

    def __init__(self, ws, base, opts):
        super().__init__(ws, base, opts)
        self.items = []
        self.resolve_image = _image_resolver(self.uploads_dir)

    def add_page(self, n, rows, page):
        props = page.get("properties") or {}
        meta = props.get("meta") if isinstance(props.get("meta"), dict) else {}
        title = re.sub(r"\s+", " ", page.get("content") or "").strip() or "Untitled"
        include_pdf = self.opts["pdf"]

        pdf_arc = None
        doc_id = props.get("doc_id")
        if include_pdf and doc_id:
            try:
                pdf_path = pdf_upload_path(self.ws, doc_id)
            except ValueError:
                pdf_path = None
            if pdf_path and pdf_path.is_file():
                data = pdf_path.read_bytes()
                if self.opts["highlights"]:
                    marks = _collect_marks([block_to_dict(r) for r in rows])
                    for m in marks:
                        m["note"] = strip_image_md(m["note"])
                    if marks:
                        try:
                            data, _ = annotate_pdf(data, marks, author=self.ws)
                        except Exception as e:
                            log.warning(f"zotero export: annotating '{title}' failed, "
                                        f"exporting bare PDF: {e}")
                            data = pdf_path.read_bytes()
                pdf_arc = f"files/{n}/{slugify(title, '')}.pdf"
                self.blobs.append((f"{self.base}/{pdf_arc}", data))

        images = []
        if include_pdf:
            seen = set()
            for node in _walk_tree(page):
                for fname in MD_IMAGE_RE.findall(node.get("content") or ""):
                    if fname in seen or not (self.uploads_dir / fname).is_file():
                        continue
                    seen.add(fname)
                    arc = f"files/{n}/{fname}"
                    self.blobs.append((f"{self.base}/{arc}", (self.uploads_dir / fname).read_bytes()))
                    images.append({"path": arc, "title": fname,
                                   "mime": IMAGE_MIME.get(fname.rsplit(".", 1)[-1].lower())
                                           or "application/octet-stream"})

        note_htmls = []
        if self.opts["notes"]:
            # Top-level non-highlight subtrees, one Zotero note each — the
            # inverse of the import's notes→child-blocks mapping. Writing
            # nested under highlights instead travels in the annotation popups.
            for child in page["children"]:
                cprops = child.get("properties") or {}
                if cprops.get("highlight_id") or cprops.get("link_url"):
                    continue
                html = note_html(child, resolve_image=self.resolve_image)
                if html:
                    note_htmls.append(html)
            # Popup comments are plain text, so a highlight whose notes carry
            # images ALSO becomes a Zotero note (page + quote header) with the
            # pictures embedded.
            for node in _walk_tree(page):
                nprops = node.get("properties") or {}
                if not nprops.get("highlight_id"):
                    continue
                if not any(MD_IMAGE_RE.search(d.get("content") or "")
                           for d in _walk_tree(node)):
                    continue
                html = highlight_memo_html(node, resolve_image=self.resolve_image)
                if html:
                    note_htmls.append(html)

        folders = [p.strip() for p in (props.get("folder") or "").split(",") if p.strip()]
        scope = self.opts.get("folder_scope")
        if scope:
            folders = [p for p in folders if p == scope or p.startswith(scope + "/")]
        arxiv = (meta or {}).get("arxiv_id") or ""
        self.items.append({
            # Real Zotero keys are "#item_<n>" — a distinct prefix for generated
            # ones so a re-exported import can't collide with a fresh page.
            "key": props.get("zotero_key")
                   or (f"https://arxiv.org/abs/{arxiv}" if arxiv else f"#gamma_item_{n}"),
            "title": title,
            "meta": meta or {},
            "tags": [t.strip() for t in (props.get("category") or "").split(",") if t.strip()],
            "folders": folders,
            "pdf_path": pdf_arc,
            "images": images,
            "notes": note_htmls,
        })

    def finish(self):
        # Zotero's import wizard can't read a .zip (it reports "unsupported
        # format") — people try exactly that, so the how-to rides along.
        readme = (
            "Import into Zotero\n"
            "==================\n\n"
            f"1. Extract this zip somewhere (keep {self.base}.rdf and files/ together).\n"
            f"2. In Zotero: File -> Import... -> \"A file\" -> pick {self.base}.rdf.\n\n"
            "Do NOT pick the .zip itself - Zotero reports 'unsupported format' for it.\n"
            "Collections, tags, notes and PDFs (highlights embedded) come along.\n"
        )
        self.entries += [(f"{self.base}/{self.base}.rdf", build_rdf(self.items)),
                         (f"{self.base}/README.txt", readme)]


class _GammaBuilder(_Builder):
    """A scoped account backup in the ``gamma-backup-1`` layout (/api/export's
    format): a pages.db holding just the selected page subtrees verbatim, a
    data.db with their AI chats (plus, on a folder export, the folder view's
    own chat buckets), and uploads/ with just the files they reference. Any
    Gamma imports it through the existing ``/api/import-data?mode=merge`` —
    additive, deduped by block id / doc id / content hash, so re-importing
    adds nothing. Lossless by construction, which is why the dialog's three
    switches don't apply to this format."""
    suffix = "-gamma.zip"

    def __init__(self, ws, base, opts):
        super().__init__(ws, base, opts)
        self.db = sqlite3.connect(":memory:")
        for stmt in PAGES_SCHEMA:
            self.db.execute(stmt)
        self.page_ids = []
        self.upload_names = set()

    def add_page(self, n, rows, page):
        self.page_ids.append(page["id"])
        for row in rows:
            # A page can sit in several exported folders only once — roots are
            # distinct — but keep the guard for shared subtrees.
            self.db.execute(
                f"INSERT OR IGNORE INTO unified_blocks ({BLOCK_COLUMNS}) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)", tuple(row))
            # Referenced uploads: any /api/uploads/<file> in content or
            # properties (source_url, pasted images), plus the doc_id PDF —
            # the same reference rule storage.cleanup_orphan_uploads applies.
            for text in (row[3] or "", row[4] or ""):
                self.upload_names.update(UPLOAD_RE.findall(text))
        doc_id = (page.get("properties") or {}).get("doc_id")
        if doc_id:
            self.upload_names.add(f"{doc_id}.pdf")

    def finish(self):
        self.db.commit()
        pages_bytes = self.db.serialize()
        self.db.close()

        chat_keys = list(self.page_ids)
        scope = self.opts.get("folder_scope")
        data_bytes = None
        with connect_data_db(self.ws) as src:
            marks = ",".join("?" for _ in chat_keys)
            rows = src.execute(
                f"SELECT block_id, messages, updated_at FROM chats WHERE block_id IN ({marks})",
                chat_keys).fetchall() if chat_keys else []
            if scope:
                rows += src.execute(
                    "SELECT block_id, messages, updated_at FROM chats "
                    "WHERE block_id = ? OR substr(block_id, 1, ?) = ?",
                    (f"home:{scope}", len(f"home:{scope}/"), f"home:{scope}/")).fetchall()
        if rows:
            out = sqlite3.connect(":memory:")
            out.execute("CREATE TABLE chats (block_id TEXT PRIMARY KEY, "
                        "messages TEXT NOT NULL, updated_at TEXT NOT NULL)")
            out.executemany("INSERT OR IGNORE INTO chats VALUES (?, ?, ?)", rows)
            out.commit()
            data_bytes = out.serialize()
            out.close()

        self.blobs.append(("pages.db", pages_bytes))
        if data_bytes:
            self.blobs.append(("data.db", data_bytes))
        self.blobs.append(("manifest.json", json.dumps({
            "format": "gamma-backup-1",  # what import-data validates
            "scope": {"folder": scope, "pages": len(self.page_ids)},
            "exported_at": page_now(),
        }, indent=2)))
        self.files += [(f"uploads/{name}", self.uploads_dir / name)
                       for name in sorted(self.upload_names)]


def _block_ref_resolver(conn):
    """id → {content, page_title, page_id} for [[refs]], ``![[embeds]]`` and
    internal document links — walks the parent chain for the root page, with a
    per-render cache (the same ref often appears many times)."""
    cache = {}

    def resolve(block_id):
        if block_id in cache:
            return cache[block_id]
        row = conn.execute(
            "SELECT content, parent_id FROM unified_blocks WHERE id = ?",
            (block_id,)).fetchone()
        result = None
        if row is not None:
            content, parent = row
            page_id, title = block_id, ""
            for _ in range(64):                  # parent chain → the page block
                if not parent or parent == "root":
                    break
                up = conn.execute(
                    "SELECT content, parent_id FROM unified_blocks WHERE id = ?",
                    (parent,)).fetchone()
                if up is None:
                    break
                page_id, title, parent = parent, (up[0] or ""), up[1]
            if page_id == block_id:              # the ref IS a page block
                title = content or ""
            result = {"content": content or "", "page_title": title.strip(),
                      "page_id": page_id}
        cache[block_id] = result
        return result

    return resolve


class _NotesPdfBuilder(_Builder):
    """The notes themselves as a PDF document (``pdf_document``): title,
    metadata, the block tree typeset as nested bullets with quotes, code,
    images and math. The only builder whose download isn't a zip — one PDF
    holds every selected page, each starting on a fresh sheet — so it
    overrides ``response`` instead of accumulating zip parts. It is also the
    only one that writes local references as LINK annotations (a recording's
    segments), which is why it needs the export's public origin: the document
    is downloaded, so ``/api/assets/…`` alone resolves nowhere (and a bare
    fetch would come from the reader's default workspace)."""
    suffix = "-notes.pdf"

    def __init__(self, ws, base, opts):
        super().__init__(ws, base, opts)
        self.pages = []

    def add_page(self, n, rows, page):
        self.pages.append(page)

    def response(self) -> Response:
        try:
            # The request's connection is closed by the time response() runs,
            # so [[ref]]/![[embed]] resolution opens its own (read-only use).
            asset_link = absolute_asset_link(self.link_base, self.ws) if self.link_base else None
            with connect_pages_db(self.ws) as conn:
                pdf_bytes = render_document(
                    self.pages, uploads_dir=self.uploads_dir,
                    highlights=self.opts["highlights"], notes=self.opts["notes"],
                    resolve_ref=_block_ref_resolver(conn), asset_link=asset_link)
        except Exception as e:
            # ``log`` is a Logger, not a function: calling it raised a second
            # TypeError that hid the real cause of a failed export.
            log.error(f"notes PDF export failed for '{self.base}': {e}")
            raise HTTPException(status_code=400, detail=f"could not build the PDF: {e}")
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": _content_disposition(f"{self.base}{self.suffix}")},
        )


_BUILDERS = {
    "readable": _MarkdownBuilder,
    "obsidian": _ObsidianBuilder,
    "logseq-graph": _LogseqBuilder,
    "zotero-rdf": _ZoteroBuilder,
    "gamma": _GammaBuilder,
    "notes-pdf": _NotesPdfBuilder,
}


def _run_export(conn, ws, mode: str, root_ids, base: str, opts: dict,
                progress: dict | None = None, link_base: str = "") -> _Builder:
    """The shared export driver: one pass over the selected pages, each handed
    to the mode's builder. ``progress`` is the /folders/export-progress dict;
    ``link_base`` the public origin an absolute-linking builder writes against
    (``_link_base`` — only the notes PDF uses it)."""
    cls = _BUILDERS.get(mode)
    if cls is None:
        raise HTTPException(status_code=400, detail=f"unknown export mode: {mode}")
    builder = cls(ws, base, opts)
    builder.link_base = link_base
    builder.begin(conn, root_ids)
    for n, root_id in enumerate(root_ids, 1):
        rows = fetch_subtree(conn, root_id)
        page = build_tree(rows, root_id)
        if page is None:
            continue
        if progress is not None:
            progress["title"] = (page.get("content") or "").strip()
        builder.add_page(n, rows, page)
        if progress is not None:
            progress["done"] += 1
    return builder


# Sync on purpose: rendering + zipping runs in FastAPI's threadpool.
@router.get("/pages/{block_id}/export")
def export_page(block_id: str, request: Request, mode: str = "readable", pdf: int = 1,
                highlights: int = 1, notes: int = 1):
    """One page in any export format (see the _Builder classes): ``readable``
    Markdown (bare .md when it references no local assets, else a .zip with an
    assets/ folder; ``highlights=0``/``notes=0`` — the dialog's switches —
    leave out the quoted PDF text or your own writing), ``obsidian`` (an
    Obsidian vault zip: the page as ``<folder>/<Title>.md`` with wikilinks,
    the PDF and images under attachments/), ``notes-pdf`` (the
    notes typeset as their own PDF document — the one format a page without a
    PDF can still export as one), ``logseq-graph`` (a complete Logseq file
    graph, both switches pinned on), ``zotero-rdf`` (a one-item Zotero RDF
    library), or ``gamma`` (a scoped account backup any Gamma imports via
    /api/import-data?mode=merge)."""
    ws = resolve_ws(request)
    scope = share_scope_page(request)
    opts = {"pdf": bool(pdf), "highlights": bool(highlights), "notes": bool(notes),
            "folder_scope": None}
    with connect_pages_db(ws) as conn:
        assert_block_in_page(conn, block_id, scope)
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="page not found")
        row = conn.execute("SELECT content FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        slug = slugify(row[0], block_id)
        builder = _run_export(conn, ws, mode, [block_id], slug, opts,
                              link_base=_link_base(request))

    # A single readable page referencing no local assets is just the .md.
    if mode == "readable" and not builder.assets:
        return _md_response(builder.entries[0][1], slug)
    return builder.response()


# Sync on purpose: PyPDF2 rewriting is CPU-bound; the threadpool keeps the loop free.
@router.get("/pages/{block_id}/export-pdf")
def export_page_pdf(block_id: str, request: Request, notes: int = 0, highlights: int = 1):
    """The page's PDF with its highlights burned in as standard /Highlight
    annotations (notes become the annotation popup text), so they survive in
    any external PDF viewer. Handwriting rides along: a ``gamma-ink`` block
    becomes ``/Ink`` annotations (vectors, re-importable), and a native iPad
    ``pdf_ink`` block is drawn onto the page as its PNG preview (or its
    per-stroke replay picture), correctly placed for the page's crop box and
    rotation — the private PKDrawing itself is not convertible here, so the
    annotation appears as the picture it is, not as editable strokes.
    ``notes=1`` additionally paints every non-empty note onto the page itself,
    in the nearest free space with a leader line back to its highlight —
    readable without opening popups, and printable. ``highlights=0`` skips the
    annotation layer and the handwriting pictures, so ``highlights=0&notes=1``
    gives a clean PDF carrying only the written notes."""
    ws = resolve_ws(request)
    scope = share_scope_page(request)
    with connect_pages_db(ws) as conn:
        assert_block_in_page(conn, block_id, scope)
        rows = fetch_subtree(conn, block_id)
    if not rows:
        raise HTTPException(status_code=404, detail="page not found")
    blocks = [block_to_dict(r) for r in rows]
    root = next(b for b in blocks if b["id"] == block_id)
    doc_id = root["properties"].get("doc_id")
    if not doc_id:
        raise HTTPException(status_code=400, detail="page has no PDF")
    try:
        pdf_path = pdf_upload_path(ws, doc_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid document id")
    if not pdf_path.is_file():
        raise HTTPException(status_code=404, detail="PDF not stored on the server")

    marks = _collect_marks(blocks)

    written = 0
    native_drawn = 0
    pdf_bytes = pdf_path.read_bytes()
    if highlights:
        uploads_dir = ws_uploads_dir(ws)
        try:
            result = annotate_pdf_result(
                pdf_bytes, marks, author=request.state.user or "",
                ink=_collect_ink(blocks, uploads_dir),
                native_ink=_collect_native_ink(blocks, uploads_dir))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"could not annotate PDF: {str(e) or type(e).__name__}") from e
        pdf_bytes = result["pdf"]
        written, native_drawn = result["annotations"], result["native_ink"]

    drawn = 0
    if notes:
        # Still positioned from the highlight rects, annotation layer or not.
        try:
            pdf_bytes, drawn = render_notes(pdf_bytes, marks,
                                            uploads_dir=ws_uploads_dir(ws))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"could not render notes: {e}")

    slug = slugify(root.get("content"), block_id)
    suffix = "-notes" if notes else "-annotated" if highlights else ""
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": _content_disposition(f"{slug}{suffix}.pdf"),
            "X-Annotations-Written": str(written),
            # Native pictures are page content, not annotations: counted apart
            # so a caller can tell "the handwriting is in the file" from
            # "an annotation viewer will find something".
            "X-Native-Ink-Drawn": str(native_drawn),
            "X-Notes-Rendered": str(drawn),
        },
    )


# Per-workspace progress of a running /folders/export, for the frontend's percent
# display (same in-memory pattern as auth.py's backup _export_progress).
_folder_export_progress: dict[str, dict] = {}


@router.get("/folders/export-progress")
def folder_export_progress(request: Request):
    if share_scope_page(request) is not None:
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    ws = resolve_ws(request)
    return _folder_export_progress.get(ws) or {"active": False, "total": 0, "done": 0}


def _page_in_folder(props: dict, name: str) -> bool:
    raw = props.get("folder") or ""
    for path in (p.strip() for p in raw.split(",")):
        if path and (path == name or path.startswith(name + "/")):
            return True
    return False


@router.get("/folders/export")
def export_folder(request: Request, name: str, mode: str = "readable", pdf: int = 1,
                  highlights: int = 1, notes: int = 1):
    """Every page tagged into folder ``name`` (or a subfolder of it), in any
    export format (see the _Builder classes): ``readable`` (one .md per page +
    a shared assets/ folder), ``obsidian`` (a vault: subfolders as
    directories, attachments/), ``notes-pdf`` (every page's notes in one PDF
    document, each starting on a fresh sheet), ``logseq-graph`` (a complete
    Logseq file graph), ``zotero-rdf`` (a Zotero RDF library — subfolders
    become collections), or ``gamma`` (a scoped account backup any Gamma
    imports via /api/import-data?mode=merge). Progress:
    /folders/export-progress."""
    name = (name or "").strip().strip("/")
    if not name:
        raise HTTPException(status_code=400, detail="folder name required")
    # A share link is scoped to one page, never a whole folder.
    if share_scope_page(request) is not None:
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    ws = resolve_ws(request)
    folder_slug = slugify(name.replace("/", "-"), "")
    opts = {"pdf": bool(pdf), "highlights": bool(highlights), "notes": bool(notes),
            "folder_scope": name}
    with connect_pages_db(ws) as conn:
        roots = conn.execute(
            f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE parent_id = 'root'"
        ).fetchall()
        matches = [b for b in (block_to_dict(r) for r in roots)
                   if _page_in_folder(b["properties"], name)]
        if not matches:
            raise HTTPException(status_code=404, detail="no pages in that folder")

        prog = {"active": True, "total": len(matches), "done": 0, "title": ""}
        _folder_export_progress[ws] = prog
        try:
            builder = _run_export(conn, ws, mode, [b["id"] for b in matches],
                                  folder_slug, opts, progress=prog,
                                  link_base=_link_base(request))
        finally:
            prog["active"] = False
    return builder.response()
