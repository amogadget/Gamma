"""Render a page's block subtree to Markdown.

Two flavours over one shared tree-walk:

- ``readable``  — clean nested bullets, highlights as blockquotes with a page
  marker, page title as an H1, scalar metadata as YAML front-matter and the
  cached BibTeX as a fenced block. Lossy but portable; the default.
- ``logseq``    — the inverse of ``logseq_import.parse_logseq_md``: tab-indented
  bullets with ``key:: value`` properties, highlights carrying ``ls-type::
  annotation`` + ``id``/``hl-color``/``hl-page``/``hl-position``. Re-importable
  via the existing Logseq importer (positions survive as a Gamma-specific
  ``hl-position`` extension; the stock importer ignores it and rebuilds the rest
  from ``id``/quote). Note that this flavour joins multi-line block content onto
  one line — the Logseq bullet format cannot represent embedded newlines.

Upload references (``/api/uploads/<sha>.<ext>``) are collected and rewritten to
relative ``assets/<sha>.<ext>`` paths as a post-processing pass over the rendered
text, so the renderers themselves stay ignorant of bundling.
"""

import json
import re

from .blocks_store import block_to_dict

# rgba → Logseq colour name, the inverse of logseq_import._LOGSEQ_COLORS (using
# the canonical name for each distinct rgba we emit).
_RGBA_TO_NAME = {
    "rgba(255, 226, 143, 0.65)": "yellow",
    "rgba(170, 235, 170, 0.65)": "green",
    "rgba(155, 205, 255, 0.65)": "blue",
    "rgba(230, 180, 255, 0.65)": "purple",
}

# /api/uploads/<hexsha>.<ext> — content-addressed, so the filename is a stable key.
UPLOAD_RE = re.compile(r"/api/uploads/([0-9a-fA-F]+\.[A-Za-z0-9]+)")

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


def _rgba_to_name(color):
    if not color:
        return None
    return _RGBA_TO_NAME.get(color.strip(), color.strip())


# --- readable flavour --------------------------------------------------------

def render_readable(page):
    """Nested-bullet Markdown with a title, YAML front-matter and BibTeX block."""
    props = page.get("properties") or {}
    title = (page.get("content") or "").strip() or "Untitled"

    fm = [f"title: {title}"]
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
        _render_readable_block(child, 0, lines)

    return "\n".join(lines).rstrip() + "\n"


def _render_readable_block(node, depth, lines):
    props = node.get("properties") or {}
    content = (node.get("content") or "").strip()
    indent = "  " * depth
    emitted = False

    if props.get("link_url"):
        label = content or (props.get("quote") or "").strip() or props["link_url"]
        lines.append(f"{indent}- [{label}]({props['link_url']})")
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
        _render_readable_block(child, child_depth, lines)


# --- logseq flavour ----------------------------------------------------------

def render_logseq(page):
    """Tab-indented ``key:: value`` Markdown, re-importable via the Logseq importer."""
    props = page.get("properties") or {}
    title = (page.get("content") or "").strip() or "Untitled"

    lines = [f"title:: {title}"]
    if props.get("doc_id"):
        lines.append(f"doc-id:: {props['doc_id']}")
    if props.get("source_url"):
        lines.append(f"source:: {props['source_url']}")
    lines.append("")

    for child in page["children"]:
        _render_logseq_block(child, 0, lines)

    return "\n".join(lines).rstrip() + "\n"


def _oneline(text):
    return " ".join((text or "").split("\n")).strip()


def _render_logseq_block(node, depth, lines):
    props = node.get("properties") or {}
    content = (node.get("content") or "").strip()
    tabs = "\t" * depth

    if _is_highlight(props):
        lines.append(f"{tabs}- {_oneline(props.get('quote') or '')}")
        lines.append(f"{tabs}  ls-type:: annotation")
        lines.append(f"{tabs}  id:: {props['highlight_id']}")
        color = _rgba_to_name(props.get("color"))
        if color:
            lines.append(f"{tabs}  hl-color:: {color}")
        if props.get("pdf_page") is not None:
            lines.append(f"{tabs}  hl-page:: {props['pdf_page']}")
        if props.get("pdf_position"):
            lines.append(f"{tabs}  hl-position:: {json.dumps(props['pdf_position'], separators=(',', ':'))}")
        if props.get("link_url"):
            lines.append(f"{tabs}  link-url:: {props['link_url']}")
        # The highlight's own note is a plain child bullet so the importer's
        # _collect_notes picks it up as the annotation's comment.
        if content:
            child_tabs = "\t" * (depth + 1)
            lines.append(f"{child_tabs}- {_oneline(content)}")
        for child in node["children"]:
            _render_logseq_block(child, depth + 1, lines)
    elif content:
        lines.append(f"{tabs}- {_oneline(content)}")
        for child in node["children"]:
            _render_logseq_block(child, depth + 1, lines)
    else:
        # Empty container: keep children at this depth.
        for child in node["children"]:
            _render_logseq_block(child, depth, lines)


# --- rendering entry point + asset handling ---------------------------------

def render_page(page, mode="readable"):
    return render_logseq(page) if mode == "logseq" else render_readable(page)


def collect_and_rewrite(md, include_pdf=True):
    """Rewrite ``/api/uploads/<sha>.<ext>`` refs to ``assets/<sha>.<ext>`` and
    return ``(new_md, {filenames})``. PDFs are left as absolute links (and not
    collected) when ``include_pdf`` is False."""
    assets = set()

    def repl(m):
        filename = m.group(1)
        if filename.lower().endswith(".pdf") and not include_pdf:
            return m.group(0)
        assets.add(filename)
        return f"assets/{filename}"

    return UPLOAD_RE.sub(repl, md), assets


def slugify(title, block_id):
    """Notion-style filename stem: sanitized title plus a short id suffix so
    same-titled pages never collide."""
    t = _INVALID_FILENAME.sub("", (title or "").strip())
    t = re.sub(r"\s+", " ", t).strip()[:80].strip() or "Untitled"
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "", block_id or "")[:12]
    return f"{t}-{safe_id}" if safe_id else t
