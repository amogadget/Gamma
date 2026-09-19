"""Render pages as a Zotero RDF library export — the inverse of
``zotero_import``: one ``.rdf`` plus a ``files/<n>/<name>.pdf`` tree, zipped.
Zotero's File → Import reads the ``.rdf`` directly (after unzipping), and
Gamma's own ``/api/import/zotero`` accepts the zip as-is, so a library
round-trips.

The element shapes mirror what Zotero itself writes (and what
``zotero_import.parse_zotero_rdf`` reads): items are bib classes carrying
``z:itemType``, the journal name/volume/DOI live on a standalone
``bib:Journal`` record referenced via ``dcterms:isPartOf``, attachments are
``z:Attachment`` elements linked by ``link:link`` with the file path in
``z:path`` (exactly what Zotero's own export writes; an ``rdf:resource``
*element* is an RDF/XML syntax term — Zotero's parser happens to tolerate one,
verified live against Zotero 9, but strict parsers like rdflib reject the
whole file, so it is never emitted), notes are ``bib:Memo`` HTML linked by
``dcterms:isReferencedBy``, and folder labels become a ``z:Collection`` tree.

The whole pipeline is verified against a real Zotero via its connector
server's ``/connector/import`` (the same translator code path as the import
wizard). Note Zotero CANNOT read the .zip itself — its wizard reports
"unsupported format" for one; the .rdf must be extracted and picked, which is
why the zip carries a README saying so.

Highlights are deliberately absent here — like Zotero's own "Include
Annotations", they travel embedded inside the exported PDF copies (the
endpoint burns them in with ``pdf_export.annotate_pdf``).
"""

import html as html_mod
import re
import xml.etree.ElementTree as ET

_NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "z": "http://www.zotero.org/namespaces/export#",
    "dcterms": "http://purl.org/dc/terms/",
    "bib": "http://purl.org/net/biblio#",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "link": "http://purl.org/rss/1.0/modules/link/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "prism": "http://prismstandard.org/namespaces/1.2/basic/",
}
for _p, _u in _NS.items():
    ET.register_namespace(_p, _u)


def _q(prefix: str, tag: str) -> str:
    return f"{{{_NS[prefix]}}}{tag}"


def _sub(parent, prefix, tag, text=None, **attrs):
    el = ET.SubElement(parent, _q(prefix, tag))
    if text is not None:
        el.text = text
    for key, value in attrs.items():
        pfx, name = key.split("_", 1)
        el.set(_q(pfx, name), value)
    return el


# --- notes: block text → the minimal HTML Zotero notes hold -----------------

# Markdown image refs to Gamma's content-addressed uploads (the image shape of
# markdown_export.UPLOAD_RE).
MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(/api/uploads/([0-9a-fA-F]+\.[A-Za-z0-9]+)\)")

IMAGE_MIME = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml",
    "bmp": "image/bmp",
}


def strip_image_md(text: str) -> str:
    """Markdown image refs → a readable placeholder. Annotation comments are
    plain text (they come from the PDF's /Contents), so the image itself
    travels embedded in a Zotero note (``highlight_memo_html``) and as an item
    attachment instead."""
    return MD_IMAGE_RE.sub(lambda m: f"(image: {m.group(1)} — see item notes)", text or "")


def _inline_html(text: str) -> str:
    """The inverse of zotero_import.html_note_text's inline rules: escape,
    then **bold**/*italic* back to tags, newlines to <br/>."""
    s = html_mod.escape(text, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", s)
    return s.replace("\n", "<br/>")


def _content_html(text: str, resolve_image) -> str:
    """Inline HTML for one block's text; markdown image refs become embedded
    ``<img src="data:...">`` (Zotero's note import keeps data URIs verbatim —
    verified live) or a plain placeholder when the file can't be resolved."""
    parts, last = [], 0
    for m in MD_IMAGE_RE.finditer(text):
        parts.append(_inline_html(text[last:m.start()]))
        data = resolve_image(m.group(1)) if resolve_image else None
        if data:
            mime, b64 = data
            parts.append(f'<img src="data:{mime};base64,{b64}"/>')
        else:
            parts.append(f"(image: {m.group(1)})")
        last = m.end()
    parts.append(_inline_html(text[last:]))
    return "".join(parts)


def note_html(node, resolve_image=None) -> str:
    """One block subtree (a ``build_tree`` node) → one Zotero note's HTML:
    the block itself as a paragraph, children as nested lists.
    ``resolve_image(filename) -> (mime, base64) | None`` embeds pasted images
    into the note."""

    def items(children):
        out = ""
        for child in children:
            content = (child.get("content") or "").strip()
            inner = items(child.get("children") or [])
            if not content and not inner:
                continue
            out += (f"<li>{_content_html(content, resolve_image)}"
                    + (f"<ul>{inner}</ul>" if inner else "") + "</li>")
        return out

    parts = ""
    content = (node.get("content") or "").strip()
    if content:
        parts += f"<p>{_content_html(content, resolve_image)}</p>"
    kids = items(node.get("children") or [])
    if kids:
        parts += f"<ul>{kids}</ul>"
    return parts


def highlight_memo_html(node, resolve_image=None) -> str:
    """A Zotero note for a highlight whose writing carries images. The
    annotation comment can only hold a plain placeholder, so the pictures live
    here — prefixed with the page and quote, so the note stays findable next
    to its annotation."""
    props = node.get("properties") or {}
    page_no = props.get("pdf_page") or (props.get("pdf_position") or {}).get("pageNumber")
    quote = re.sub(r"\s+", " ", props.get("quote") or "").strip()
    header = " — ".join(part for part in (
        f"p.{page_no}" if page_no else "",
        f"“{quote[:120]}”" if quote else "",
    ) if part)
    body = note_html(node, resolve_image)
    if not body:
        return ""
    head = f"<p><strong>{html_mod.escape(header, quote=False)}</strong></p>" if header else ""
    return head + body


# --- the RDF document -------------------------------------------------------

def _person(seq, name: str):
    li = ET.SubElement(seq, _q("rdf", "li"))
    person = ET.SubElement(li, _q("foaf", "Person"))
    parts = name.strip().split()
    _sub(person, "foaf", "surname", parts[-1] if parts else name)
    if len(parts) > 1:
        _sub(person, "foaf", "givenName", " ".join(parts[:-1]))


def build_rdf(items: list[dict]) -> str:
    """items: one dict per page —
    ``{key, title, meta, tags, folders, pdf_path, notes}`` where ``pdf_path``
    is the zip path relative to the .rdf (or None) and ``notes`` is a list of
    HTML strings. → the .rdf document text."""
    root = ET.Element(_q("rdf", "RDF"))

    folder_paths = set()
    for n, item in enumerate(items, 1):
        meta = item.get("meta") or {}
        arxiv = (meta.get("arxiv_id") or "").strip()
        venue = (meta.get("venue") or "").strip()
        doi = (meta.get("doi") or "").strip()
        # Published venue → journalArticle with a journal record; bare arXiv id
        # → preprint; neither → generic document. All three re-import cleanly.
        if venue:
            tag, item_type = ("bib", "Article"), "journalArticle"
        elif arxiv:
            tag, item_type = ("rdf", "Description"), "preprint"
        else:
            tag, item_type = ("rdf", "Description"), "document"

        el = _sub(root, *tag, rdf_about=item["key"])
        _sub(el, "z", "itemType", item_type)
        if venue:
            journal_key = f"#journal_{n}"
            _sub(el, "dcterms", "isPartOf", rdf_resource=journal_key)
            journal = _sub(root, "bib", "Journal", rdf_about=journal_key)
            _sub(journal, "dc", "title", venue)
            if meta.get("volume"):
                _sub(journal, "prism", "volume", str(meta["volume"]))
            if doi:
                _sub(journal, "dc", "identifier", f"DOI {doi}")
        elif doi:
            _sub(el, "dc", "identifier", f"DOI {doi}")

        authors = meta.get("authors")
        if isinstance(authors, list) and authors:
            seq = ET.SubElement(ET.SubElement(el, _q("bib", "authors")), _q("rdf", "Seq"))
            for name in authors:
                if str(name).strip():
                    _person(seq, str(name))

        _sub(el, "dc", "title", item["title"])
        year = str(meta.get("year") or "").strip()
        if year:
            _sub(el, "dc", "date", year)
        if meta.get("pages"):
            _sub(el, "bib", "pages", str(meta["pages"]))
        if arxiv:
            uri = _sub(_sub(el, "dc", "identifier"), "dcterms", "URI")
            _sub(uri, "rdf", "value", f"https://arxiv.org/abs/{arxiv}")
        for t in item.get("tags") or []:
            _sub(el, "dc", "subject", t)

        if item.get("pdf_path"):
            attach_key = f"#attach_{n}"
            _sub(el, "link", "link", rdf_resource=attach_key)
            att = _sub(root, "z", "Attachment", rdf_about=attach_key)
            _sub(att, "z", "itemType", "attachment")
            _sub(att, "z", "path", rdf_resource=item["pdf_path"])
            _sub(att, "dc", "title", "PDF")
            _sub(att, "link", "type", "application/pdf")

        # Pasted note images ride as further attachments on the item — the
        # counterpart of the "(image: …)" placeholders in annotation comments.
        for k, img in enumerate(item.get("images") or [], 1):
            img_key = f"#img_{n}_{k}"
            _sub(el, "link", "link", rdf_resource=img_key)
            att = _sub(root, "z", "Attachment", rdf_about=img_key)
            _sub(att, "z", "itemType", "attachment")
            _sub(att, "z", "path", rdf_resource=img["path"])
            _sub(att, "dc", "title", img.get("title") or "Image")
            _sub(att, "link", "type", img.get("mime") or "application/octet-stream")

        for i, html in enumerate(item.get("notes") or [], 1):
            memo_key = f"#note_{n}_{i}"
            _sub(el, "dcterms", "isReferencedBy", rdf_resource=memo_key)
            memo = _sub(root, "bib", "Memo", rdf_about=memo_key)
            _sub(memo, "rdf", "value", html)

        for path in item.get("folders") or []:
            parts = [p for p in path.split("/") if p]
            for i in range(len(parts)):
                folder_paths.add("/".join(parts[: i + 1]))

    # Folder labels → the collection tree (hasPart links members AND children).
    ids = {path: f"#collection_{i}" for i, path in enumerate(sorted(folder_paths), 1)}
    for path in sorted(folder_paths):
        col = _sub(root, "z", "Collection", rdf_about=ids[path])
        _sub(col, "dc", "title", path.rsplit("/", 1)[-1])
        for other in sorted(folder_paths):
            if other.rsplit("/", 1)[0] == path and other != path:
                _sub(col, "dcterms", "hasPart", rdf_resource=ids[other])
        for item in items:
            if path in (item.get("folders") or []):
                _sub(col, "dcterms", "hasPart", rdf_resource=item["key"])

    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode")
