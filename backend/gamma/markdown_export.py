"""Render a page's block subtree to readable Markdown: clean nested bullets,
highlights as blockquotes with a page marker, page title as an H1, scalar
metadata as YAML front-matter and the cached BibTeX as a fenced block. Lossy
but portable. (Logseq-app export lives in ``logseq_graph_export``.)

Upload references (``/api/uploads/<sha>.<ext>``) are collected and rewritten to
relative ``assets/<sha>.<ext>`` paths as a post-processing pass over the rendered
text, so the renderers themselves stay ignorant of bundling.
"""

import re

from .blocks_store import block_to_dict

# rgba → Logseq colour name, the inverse of logseq_import._LOGSEQ_COLORS (using
# the canonical name for each distinct rgba we emit). Used by the Logseq graph
# export.
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


# --- readable rendering ------------------------------------------------------

def render_readable(page, highlights=True, notes=True):
    """Nested-bullet Markdown with a title, YAML front-matter and BibTeX block.

    ``highlights``/``notes`` are the export dialog's two switches: dropping
    highlights leaves your own writing, dropping notes leaves a bare quote
    extract. The front-matter and BibTeX describe the page itself and always
    stay.
    """
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
        _render_readable_block(child, 0, lines, highlights, notes)

    return "\n".join(lines).rstrip() + "\n"


def _render_readable_block(node, depth, lines, highlights=True, notes=True):
    props = node.get("properties") or {}
    content = (node.get("content") or "").strip()
    # The two export switches. A highlight block carries both a PDF region and
    # (often) writing of your own, so dropping highlights keeps its text as a
    # plain bullet rather than losing the note with the quote.
    if props.get("highlight_id") or props.get("link_url"):
        if not highlights:
            props = {}
        if not notes:
            content = ""
    elif not notes:
        content = ""
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
        _render_readable_block(child, child_depth, lines, highlights, notes)


# --- asset handling ----------------------------------------------------------


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
