"""Render pages as an Obsidian vault: one ``<Title>.md`` per page in a
directory tree that mirrors the folder labels, attachments (images and the
PDFs) in ``attachments/``, links in Obsidian's own syntax, and a minimal
``.obsidian/app.json`` so the folder opens as a vault and re-imports as one.

The shape follows what Obsidian expects from another app (see
docs/research/obsidian.md): the filename is the title (no H1), the outline is
flattened Logseq-importer style — top-level headings and paragraphs, deeper
blocks as nested lists — and metadata is front matter (``tags`` from the
labels, ``aliases``, ``source``, ``doi``, ``authors``, ``year``).

Links resolve against the export set: a ``[[id]]`` mention of a page in the
export becomes ``[[Title]]`` (``[[dir/Title]]`` when two exported pages share
a name), a mention of a block ``[[Title#^id]]`` and a ``![[embed]]``
``![[Title#^id]]`` — the target block gets `` ^id`` written after it (only
blocks that are actually linked carry an anchor). Highlights are
``[!quote]`` callouts whose title links the bundled PDF's page
(``[[Paper.pdf#page=3|p. 3]]``); the PDF is also the quoted
``source: "[[Paper.pdf]]"`` property. Targets outside the export degrade the
way the readable Markdown export does (text, or the materialized block).

Upload references are rewritten by the caller with ``collect_and_rewrite``
(prefix ``attachments/``), as for the readable export.
"""

import json
import re

from .markdown_export import _BLOCK_REF_RE, _link_label, resolve_block_links
from .note_markup import obsidian_image_sizes

# What Obsidian refuses in a note name on any OS (link syntax) plus the
# Windows set, and control characters.
_INVALID_NAME = re.compile(r'[<>:"/\\|?*#^\[\]\x00-\x1f]')
_HEADING_RE = re.compile(r"^#{1,6}\s+\S")
# Blocks whose anchor must sit on its own line after them (Obsidian's rule
# for lists, quotes, callouts, tables and fences).
_COMPOUND_RE = re.compile(r"^(```|~~~|>|\||\$\$|[-*+] |\d+[.)] )")
_MARKER_RE = re.compile(r"[^A-Za-z0-9-]")

APP_JSON = json.dumps({"attachmentFolderPath": "attachments"}, indent=2) + "\n"


def vault_name(title: str) -> str:
    """A page title as an Obsidian-safe file/link name."""
    t = _INVALID_NAME.sub(" ", title or "")
    t = re.sub(r"\s+", " ", t).strip().lstrip(".").rstrip(". ")
    return t[:80].rstrip(". ") or "Untitled"


def anchor_marker(block_id: str) -> str:
    """A block id as an Obsidian block identifier (letters, digits, dashes)."""
    return _MARKER_RE.sub("-", block_id or "")


def _yaml_text(value: str) -> str:
    """A scalar for the front matter, quoted when YAML would misread it."""
    v = str(value)
    if re.search(r'[:#\[\]{}&*!|>\'"%@`,]|^\s|\s$', v) or v.lower() in ("true", "false", "null", "yes", "no") \
            or re.match(r"^[\d.+-]", v) and not re.match(r"^\d{4}$", v):
        return json.dumps(v, ensure_ascii=False)
    return v


def _yaml_list(key: str, items) -> list:
    return [f"{key}:"] + [f"  - {_yaml_text(i)}" for i in items]


class VaultContext:
    """Everything a page render needs from the export set: filenames, link
    texts, bundled PDF names, the anchors of linked blocks, and a block
    resolver (``id → {content, page_title, page_id} | None``)."""

    def __init__(self, resolve_ref, include_pdf=True):
        self.resolve_ref = resolve_ref
        self.include_pdf = include_pdf
        self.page_file = {}     # page id → arcname (dir/Title.md)
        self.link_text = {}     # page id → [[link text]] (Title or dir/Title)
        self.pdf_name = {}      # page id → attachments/<Name>.pdf arcname
        self.anchors = {}       # block id → ^marker (blocks linked from the export)

    # --- naming (built once, before any page renders) ------------------------

    def name_pages(self, pages, folder_scope=None):
        """``pages``: (page id, title, folder label) in export order."""
        used = set()
        for pid, title, folder in pages:
            directory = _page_dir(folder, folder_scope)
            stem = vault_name(title)
            name = stem
            n = 1
            while f"{directory}{name}.md".lower() in used:
                n += 1
                name = f"{stem} {n}"
            used.add(f"{directory}{name}.md".lower())
            self.page_file[pid] = f"{directory}{name}.md"
        # Obsidian resolves a bare [[Name]] anywhere in the vault; when two
        # exported pages share a name the folder path disambiguates.
        counts = {}
        for arc in self.page_file.values():
            counts[arc.rsplit("/", 1)[-1].lower()] = counts.get(arc.rsplit("/", 1)[-1].lower(), 0) + 1
        for pid, arc in self.page_file.items():
            stem = arc[:-3]
            leaf = stem.rsplit("/", 1)[-1]
            self.link_text[pid] = leaf if counts[arc.rsplit("/", 1)[-1].lower()] == 1 else stem

    def name_pdf(self, page_id, title, doc_id):
        """The bundled PDF's arcname for a page (shared by pages of one document)."""
        for pid, arc in self.pdf_name.items():
            if arc[1] == doc_id:
                self.pdf_name[page_id] = arc
                return arc[0]
        stem = vault_name(title)
        name, n = stem, 1
        taken = {a[0].lower() for a in self.pdf_name.values()}
        while f"attachments/{name}.pdf".lower() in taken:
            n += 1
            name = f"{stem} {n}"
        self.pdf_name[page_id] = (f"attachments/{name}.pdf", doc_id)
        return f"attachments/{name}.pdf"

    def pdf_leaf(self, page_id):
        arc = self.pdf_name.get(page_id)
        return arc[0].rsplit("/", 1)[-1] if arc else None

    def note_anchor(self, block_id):
        """Register a linked block; returns its marker."""
        marker = self.anchors.get(block_id)
        if marker is None:
            marker = self.anchors[block_id] = anchor_marker(block_id)
        return marker


def _page_dir(folder_label, folder_scope):
    folders = [t.strip() for t in (folder_label or "").split(",") if t.strip()]
    if folder_scope:
        folders = [f[len(folder_scope) + 1:] for f in folders if f.startswith(folder_scope + "/")]
    if not folders:
        return ""
    segs = [vault_name(s) for s in folders[0].split("/") if s.strip()]
    return "/".join(segs) + "/" if segs else ""


# --- links -------------------------------------------------------------------

def resolve_links(md, ctx: VaultContext, page_id):
    """``[[id]]`` / ``![[id]]`` → Obsidian links into the export set; targets
    outside it fall back to the readable export's rendering."""
    def repl(m):
        is_embed, block_id = m.group(1), m.group(2)
        ref = ctx.resolve_ref(block_id) if ctx.resolve_ref else None
        target_page = ref.get("page_id") if ref else None
        if not ref or target_page not in ctx.page_file:
            return resolve_block_links(m.group(0), ctx.resolve_ref, None, page_id)
        text = "" if target_page == page_id else ctx.link_text[target_page]
        if block_id == target_page:                 # the page itself
            return f"{is_embed}[[{text or ctx.link_text[target_page]}]]"
        return f"{is_embed}[[{text}#^{ctx.note_anchor(block_id)}]]"

    return _BLOCK_REF_RE.sub(repl, md)


def referenced_blocks(texts, ctx: VaultContext):
    """Register anchors for every ``[[id]]`` / ``![[id]]`` in ``texts`` whose
    target block lives inside an exported page (a page's own root needs
    none — it is linked by title)."""
    for text in texts:
        for m in _BLOCK_REF_RE.finditer(text or ""):
            block_id = m.group(2)
            ref = ctx.resolve_ref(block_id)
            if ref and ref.get("page_id") in ctx.page_file and block_id != ref["page_id"]:
                ctx.note_anchor(block_id)


# --- rendering ---------------------------------------------------------------

def render_vault_page(page, ctx: VaultContext, highlights=True, notes=True):
    props = page.get("properties") or {}
    title = (page.get("content") or "").strip() or "Untitled"
    page_id = page["id"]

    fm = []
    if vault_name(title) != title:
        fm.append(f"title: {_yaml_text(title)}")
    tags = [t.strip() for t in (props.get("category") or "").split(",") if t.strip()]
    if tags:
        fm += _yaml_list("tags", dict.fromkeys(tags))
    aliases = props.get("aliases")
    if isinstance(aliases, list) and aliases:
        fm += _yaml_list("aliases", [str(a) for a in aliases if str(a).strip()])
    pdf_leaf = ctx.pdf_leaf(page_id)
    if pdf_leaf:
        fm.append(f'source: "[[{pdf_leaf}]]"')
    elif props.get("source_url"):
        fm.append(f"source: {_yaml_text(props['source_url'])}")
    meta = props.get("meta")
    if isinstance(meta, dict):
        if meta.get("doi"):
            fm.append(f"doi: {_yaml_text(meta['doi'])}")
        authors = meta.get("authors")
        if isinstance(authors, list) and authors:
            fm += _yaml_list("authors", [str(a) for a in authors])
        elif authors:
            fm += _yaml_list("authors", [a.strip() for a in str(authors).split(",") if a.strip()])
        if meta.get("year"):
            fm.append(f"year: {meta['year']}")

    lines = ["---", *fm, "---", ""] if fm else []
    if props.get("bibtex"):
        lines += ["```bibtex", (props["bibtex"] or "").strip(), "```", ""]

    r = _Renderer(ctx, page_id, pdf_leaf, highlights, notes)
    for child in page["children"]:
        r.top(child, lines)
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text).strip("\n")
    return text + "\n"


class _Renderer:
    def __init__(self, ctx, page_id, pdf_leaf, highlights, notes):
        self.ctx, self.page_id, self.pdf_leaf = ctx, page_id, pdf_leaf
        self.highlights, self.notes = highlights, notes

    def _content(self, node):
        content = obsidian_image_sizes((node.get("content") or "").strip())
        content = resolve_links(content, self.ctx, self.page_id)
        return content if self.notes else ""

    def _props(self, node):
        props = node.get("properties") or {}
        if not self.highlights and (props.get("highlight_id") or props.get("link_url")):
            return {}
        return props

    def _page_link(self, props):
        page_no = props.get("pdf_page")
        if page_no is None:
            return ""
        return f"[[{self.pdf_leaf}#page={page_no}|p. {page_no}]]" if self.pdf_leaf else f"p. {page_no}"

    def _region(self, props, content):
        """A PDF link region → a link line, or None when it isn't one."""
        if not (props.get("link_url") or props.get("link_page_id")):
            return None
        target = props.get("link_page_id")
        label = content or (props.get("quote") or "").strip()
        if target and target in self.ctx.page_file:
            text = self.ctx.link_text[target]
            return f"[[{text}|{label}]]" if label and label != text else f"[[{text}]]"
        if not label and self.ctx.resolve_ref and target:
            ref = self.ctx.resolve_ref(target)
            label = _link_label((ref or {}).get("content"), "")
        href = props.get("link_url") or ""
        return f"[{label or href}]({href})" if href else (label or None)

    def _marker(self, node):
        return self.ctx.anchors.get(node["id"])

    # --- document style (top level, and under a top-level heading) ---------

    def top(self, node, lines):
        props = self._props(node)
        content = self._content(node)
        marker = self._marker(node)
        region = self._region(props, content)
        quote = (props.get("quote") or "").strip() if props.get("highlight_id") else ""

        if region:
            lines += [region + (f" ^{marker}" if marker else ""), ""]
            self._children_as_list(node, lines)
        elif quote:
            title = self._page_link(props)
            lines.append(f"> [!quote] {title}".rstrip())
            lines += [f"> {q}" for q in quote.split("\n")]
            if marker:
                lines += ["", f"^{marker}"]
            lines.append("")
            if content:
                lines += [content, ""]
            self._children_as_list(node, lines)
        elif content and _HEADING_RE.match(content):
            self._paragraph(content, marker, lines)
            for child in node["children"]:
                self.top(child, lines)
        elif content and node["children"]:
            # A block with children keeps its subtree as a nested list (a
            # paragraph can't own children in Markdown).
            self.item(node, 0, lines)
            lines.append("")
        elif content:
            self._paragraph(content, marker, lines)
        else:
            for child in node["children"]:
                self.top(child, lines)

    def _paragraph(self, content, marker, lines):
        if marker and _COMPOUND_RE.match(content):
            lines += [content, "", f"^{marker}", ""]
        elif marker:
            lines += [f"{content} ^{marker}", ""]
        else:
            lines += [content, ""]

    def _children_as_list(self, node, lines):
        if not node["children"]:
            return
        for child in node["children"]:
            self.item(child, 0, lines)
        lines.append("")

    # --- list style (everything below the top level) -------------------------

    def item(self, node, indent, lines):
        props = self._props(node)
        content = self._content(node)
        marker = self._marker(node)
        region = self._region(props, content)
        quote = (props.get("quote") or "").strip() if props.get("highlight_id") else ""
        pad = " " * indent
        emitted = True

        if region:
            lines.append(f"{pad}- {region}" + (f" ^{marker}" if marker else ""))
        elif quote:
            qlines = quote.split("\n")
            lines.append(f"{pad}- > {qlines[0]}" + (f" ^{marker}" if marker else ""))
            lines += [f"{pad}  > {q}" for q in qlines[1:]]
            link = self._page_link(props)
            if link:
                lines.append(f"{pad}  {link}")
            lines += [f"{pad}  {c}" for c in content.split("\n")] if content else []
        elif content:
            clines = content.split("\n")
            lines.append(f"{pad}- {clines[0]}" + (f" ^{marker}" if marker else ""))
            lines += [f"{pad}  {c}" for c in clines[1:]]
        else:
            emitted = False

        child_indent = indent + 2 if emitted else indent
        for child in node["children"]:
            self.item(child, child_indent, lines)
