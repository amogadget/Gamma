"""Render a page's block subtree to readable Markdown: clean nested bullets,
highlights as blockquotes with a page marker, page title as an H1, scalar
metadata as YAML front-matter and the cached BibTeX as a fenced block. Lossy
but portable. (Logseq-app export lives in ``logseq_graph_export``.)

Upload references (``/api/uploads/<sha>.<ext>``, and the native assets that also
answer to ``/api/assets/<sha>.<ext>``) are collected and rewritten to relative
``assets/<sha>.<ext>`` paths as a post-processing pass over the rendered text,
so the renderers themselves stay ignorant of bundling.
"""

import re
# aliased: _render_readable_block has a local ``quote`` (the highlight text)
from urllib.parse import quote as urlquote

from .blocks_store import block_to_dict
from .native_ink import AUDIO_REF_RE, DRAWING_REF_RE, PREVIEW_REF_RE, REPLAY_REF_RE
from .note_markup import obsidian_image_sizes

# rgba → Logseq colour name, the inverse of logseq_import._LOGSEQ_COLORS (using
# the canonical name for each distinct rgba we emit). Used by the Logseq graph
# export.
_RGBA_TO_NAME = {
    "rgba(255, 226, 143, 0.65)": "yellow",
    "rgba(170, 235, 170, 0.65)": "green",
    "rgba(155, 205, 255, 0.65)": "blue",
    "rgba(230, 180, 255, 0.65)": "purple",
}

# /api/uploads/<hexsha>.<ext> — content-addressed, so the filename is a stable
# key. Native annotation assets (gamma/native_ink.py) live in the same directory
# and answer to /api/assets/<hexsha>.<ext> as well, so both forms name the same
# file and both are collected/rewritten.
UPLOAD_RE = re.compile(r"/api/(?:uploads|assets)/([0-9a-fA-F]+\.[A-Za-z0-9]+)")

_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


# --- tree assembly -----------------------------------------------------------

def build_tree(rows, root_id):
    """Assemble ``fetch_subtree`` rows into a nested node (children sorted by
    position). Returns the root node, or ``None`` if root_id isn't present."""
    by_id = {}
    for r in rows:
        node = block_to_dict(r)
        node["children"] = []
        by_id[node["id"]] = node
    for node in by_id.values():
        parent = by_id.get(node["parent_id"])
        if parent is not None:
            parent["children"].append(node)
    for node in by_id.values():
        node["children"].sort(key=lambda n: n["position"])
    return by_id.get(root_id)


def _is_highlight(props):
    return bool(props.get("highlight_id"))


def _asset_ref(props, key):
    """A stored asset URL as text. Never None and never a non-string, so a
    corrupt property can only fail the pattern check, not raise in a renderer."""
    value = (props or {}).get(key)
    return value if isinstance(value, str) else ""


# --- readable rendering ------------------------------------------------------

def render_readable(page, highlights=True, notes=True, resolve_ref=None, page_file=None,
                    folder_scope=None):
    """Nested-bullet Markdown with a title, YAML front-matter and BibTeX block.

    ``highlights``/``notes`` are the export dialog's two switches: dropping
    highlights leaves your own writing, dropping notes leaves a bare quote
    extract. The front-matter and BibTeX describe the page itself and always
    stay. ``resolve_ref`` (block id → {content, page_title, page_id} | None)
    and ``page_file`` (page id → exported filename | None) resolve [[refs]],
    ![[embeds]] and internal document links — see ``resolve_block_links``.
    ``folder_scope`` is the folder a folder export was opened on: the page's
    folder label is written relative to it (``folder:``), so importing the
    zip into a folder rebuilds the same tree there.
    """
    props = page.get("properties") or {}
    title = (page.get("content") or "").strip() or "Untitled"

    fm = [f"title: {title}"]
    folders = [t.strip() for t in (props.get("folder") or "").split(",") if t.strip()]
    if folder_scope:
        folders = [f[len(folder_scope) + 1:] for f in folders if f.startswith(folder_scope + "/")]
    if folders:
        fm.append(f"folder: {folders[0]}")
    if props.get("source_url"):
        fm.append(f"source: {props['source_url']}")
    meta = props.get("meta")
    if isinstance(meta, dict):
        if meta.get("doi"):
            fm.append(f"doi: {meta['doi']}")
        authors = meta.get("authors")
        if isinstance(authors, list) and authors:
            fm.append(f"authors: {', '.join(str(a) for a in authors)}")
        elif authors:
            fm.append(f"authors: {authors}")
        if meta.get("year"):
            fm.append(f"year: {meta['year']}")

    lines = ["---", *fm, "---", "", f"# {title}", ""]
    if props.get("bibtex"):
        lines += ["```bibtex", (props["bibtex"] or "").strip(), "```", ""]

    for child in page["children"]:
        _render_readable_block(child, 0, lines, highlights, notes,
                               resolve_ref, page_file, page["id"])

    return "\n".join(lines).rstrip() + "\n"


# [[id]] mention / ![[id]] synced-block embed — the same id charset the
# editor's mdPreprocess matches.
_BLOCK_REF_RE = re.compile(r"(!?)\[\[([A-Za-z0-9_-]+)\]\]")


def _link_label(text, fallback):
    """First line of a target's content as a markdown-safe link label."""
    first = (text or "").strip().split("\n")[0].strip()
    first = re.sub(r"[\[\]]", "", first).strip()
    return first[:80] or fallback


def resolve_block_links(md, resolve_ref, page_file=None, page_id=None, nested=False):
    """Rewrite ``[[id]]`` mentions and ``![[id]]`` embeds for the readable
    export. A mention becomes ``[first line](<target file>)`` when its page is
    part of the export (``page_file``: page id → zip filename) and just the
    text when it isn't; an embed materializes the synced block's content, with
    a ``from`` attribution when the source lives on another page. ``page_id``
    is the page being rendered (same-page targets don't link to their own
    file); ``nested`` marks content already inside an embed, where further
    embeds degrade to mentions so transclusion can't recurse. An id the
    resolver doesn't know stays as typed."""
    if not resolve_ref:
        return md

    def target_href(target_page):
        if not page_file or not target_page or target_page == page_id:
            return None
        filename = page_file(target_page)
        return urlquote(filename) if filename else None

    def repl(m):
        is_embed, block_id = m.group(1), m.group(2)
        ref = resolve_ref(block_id)
        if not ref:
            return m.group(0)
        href = target_href(ref.get("page_id"))
        content = obsidian_image_sizes((ref.get("content") or "").strip())
        if is_embed and not nested and content:
            content = resolve_block_links(content, resolve_ref, page_file,
                                          page_id=ref.get("page_id"), nested=True)
            title = _link_label(ref.get("page_title"), "source")
            if href:
                return f"{content} *(from [{title}]({href}))*"
            if ref.get("page_id") != page_id and (ref.get("page_title") or "").strip():
                return f"{content} *(from {title})*"
            return content
        # A mention — or an embed degrading to one (nested, or empty target).
        label = _link_label(content, block_id)
        return f"[{label}]({href})" if href else label

    return _BLOCK_REF_RE.sub(repl, md)


def _render_readable_block(node, depth, lines, highlights=True, notes=True,
                           resolve_ref=None, page_file=None, page_id=None):
    props = node.get("properties") or {}
    content = obsidian_image_sizes((node.get("content") or "").strip())
    content = resolve_block_links(content, resolve_ref, page_file, page_id)
    # The two export switches. A highlight block carries both a PDF region and
    # (often) writing of your own, so dropping highlights keeps its text as a
    # plain bullet rather than losing the note with the quote. A native ink
    # annotation is the same kind of thing (a PDF region plus its caption), so
    # the highlights switch governs it too.
    if not highlights and (props.get("highlight_id") or props.get("link_url")
                           or props.get("ink_url") or props.get("type") == "pdf_ink"):
        props = {}
    if not notes:
        content = ""
    indent = "  " * depth
    emitted = False

    # A link region: an internal document link whose paper is in the export
    # links to its .md by relative filename; otherwise the stored URL.
    link_href = None
    if props.get("link_url") or props.get("link_page_id"):
        filename = page_file(props["link_page_id"]) \
            if page_file and props.get("link_page_id") else None
        link_href = urlquote(filename) if filename else (props.get("link_url") or None)

    if link_href:
        label = content or (props.get("quote") or "").strip()
        if not label and resolve_ref and props.get("link_page_id"):
            ref = resolve_ref(props["link_page_id"])
            label = _link_label((ref or {}).get("content"), "")
        lines.append(f"{indent}- [{label or link_href}]({link_href})")
        emitted = True
    elif _is_highlight(props):
        quote = (props.get("quote") or "").strip()
        if quote:
            qlines = quote.split("\n")
            lines.append(f"{indent}- > {qlines[0]}")
            for q in qlines[1:]:
                lines.append(f"{indent}  > {q}")
            page_no = props.get("pdf_page")
            if page_no is not None:
                lines.append(f"{indent}  `p.{page_no}`")
            emitted = True
        if content:
            if emitted:
                for c in content.split("\n"):
                    lines.append(f"{indent}  {c}")
            else:
                lines.append(f"{indent}- {content}")
                emitted = True
    elif props.get("ink_url"):
        # A handwriting group: its picture (the builder renders the .ink file
        # to an SVG of the same stem — ink_svg_name) and the caption under it.
        page_no = props.get("pdf_page")
        label = f"Handwriting (p.{page_no})" if page_no else "Handwriting"
        lines.append(f"{indent}- ![{label}]({ink_svg_name(props['ink_url'])})")
        for c in content.split("\n") if content else []:
            lines.append(f"{indent}  {c}")
        emitted = True
    elif props.get("type") == "pdf_ink":
        # A native PencilKit annotation: the preview picture, the editable
        # drawing and (once one exists) the replay timeline. All three are
        # bundled like any other asset, so the zip keeps the annotation
        # restorable rather than only visible.
        preview = _asset_ref(props, "preview_asset")
        if PREVIEW_REF_RE.fullmatch(preview):
            lines.append(f"{indent}- ![Ink annotation]({preview})")
            emitted = True
        drawing = _asset_ref(props, "ink_asset")
        if DRAWING_REF_RE.fullmatch(drawing):
            lines.append(f"{indent}  [Editable PencilKit drawing]({drawing})")
            emitted = True
        replay = _asset_ref(props, "replay_asset")
        if REPLAY_REF_RE.fullmatch(replay):
            lines.append(f"{indent}  [Ink replay]({replay})")
            emitted = True
        for c in content.split("\n") if content else []:
            lines.append(f"{indent}  {c}")
        emitted = emitted or bool(content)
    elif notes and props.get("type") == "audio":
        # A native recording: one link per segment (the asset is an opaque
        # .m4a the client plays), then whatever note text was typed with it.
        for seg in props.get("segments") or []:
            asset = _asset_ref(seg, "asset") if isinstance(seg, dict) else ""
            if AUDIO_REF_RE.fullmatch(asset):
                lines.append(f"{indent}- [Audio recording]({asset}) ({seg.get('duration', 0)}s)")
                emitted = True
        for c in content.split("\n") if content else []:
            lines.append(f"{indent}  {c}")
        emitted = emitted or bool(content)
    elif content:
        clines = content.split("\n")
        lines.append(f"{indent}- {clines[0]}")
        for c in clines[1:]:
            lines.append(f"{indent}  {c}")
        emitted = True

    # Blocks with nothing to show (empty containers) don't consume an indent
    # level, so their children stay at the current depth rather than orphaning.
    child_depth = depth + 1 if emitted else depth
    for child in node["children"]:
        _render_readable_block(child, child_depth, lines, highlights, notes,
                               resolve_ref, page_file, page_id)


# --- asset handling ----------------------------------------------------------

def ink_svg_name(ink_url: str) -> str:
    """The upload URL a handwriting group's rendered picture is written
    under: the ``.ink`` file's stem with ``.svg``. No such upload exists —
    the export builders generate the SVG (``gamma.ink.to_svg``) as a blob at
    the rewritten asset path, so the link resolves inside the zip."""
    return re.sub(r"\.ink$", ".svg", ink_url or "")


def collect_and_rewrite(md, include_pdf=True, prefix="assets/"):
    """Rewrite ``/api/uploads/<sha>.<ext>`` refs to ``<prefix><sha>.<ext>`` and
    return ``(new_md, {filenames})``. PDFs are left as absolute links (and not
    collected) when ``include_pdf`` is False."""
    assets = set()

    def repl(m):
        filename = m.group(1)
        if filename.lower().endswith(".pdf") and not include_pdf:
            return m.group(0)
        assets.add(filename)
        return f"{prefix}{filename}"

    return UPLOAD_RE.sub(repl, md), assets


def slugify(title, block_id):
    """Notion-style filename stem: sanitized title plus a short id suffix so
    same-titled pages never collide."""
    t = _INVALID_FILENAME.sub("", (title or "").strip())
    t = re.sub(r"\s+", " ", t).strip()[:80].strip() or "Untitled"
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "", block_id or "")[:12]
    return f"{t}-{safe_id}" if safe_id else t
