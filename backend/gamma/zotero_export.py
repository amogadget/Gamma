"""Render Gamma pages as a Zotero RDF library.

The RDF mirrors the shapes parsed by :mod:`gamma.zotero_import`: bibliographic
items link to PDF attachments, Memo notes, tags, and a nested Collection tree.
PDF highlights are embedded separately by the export router.
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
for _prefix, _uri in _NS.items():
    ET.register_namespace(_prefix, _uri)


def _q(prefix: str, tag: str) -> str:
    return f"{{{_NS[prefix]}}}{tag}"


def _sub(parent, prefix, tag, text=None, **attrs):
    element = ET.SubElement(parent, _q(prefix, tag))
    if text is not None:
        element.text = text
    for key, value in attrs.items():
        attr_prefix, name = key.split("_", 1)
        element.set(_q(attr_prefix, name), value)
    return element


# Only content-addressed local upload references are eligible. The filename
# grammar excludes separators and traversal before any filesystem lookup.
MD_IMAGE_RE = re.compile(
    r"!\[[^\]]*\]\(/api/uploads/([0-9a-fA-F]+\.[A-Za-z0-9]+)\)"
)
IMAGE_MIME = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "bmp": "image/bmp",
}


def strip_image_md(text: str, see_item_notes: bool = True) -> str:
    """Replace images in plain PDF annotation comments with readable text."""
    def replacement(match):
        suffix = " — see item notes" if see_item_notes else ""
        return f"(image: {match.group(1)}{suffix})"

    return MD_IMAGE_RE.sub(replacement, text or "")


def _inline_html(text: str) -> str:
    """Escape block text and retain the small Markdown subset notes support."""
    escaped = html_mod.escape(text, quote=False)
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", escaped)
    return escaped.replace("\n", "<br/>")


def _content_html(text: str, resolve_image) -> str:
    """Render text safely, resolving eligible image refs between escaped spans."""
    parts = []
    last = 0
    for match in MD_IMAGE_RE.finditer(text):
        parts.append(_inline_html(text[last:match.start()]))
        data = resolve_image(match.group(1)) if resolve_image else None
        if data:
            mime, encoded = data
            parts.append(f'<img src="data:{mime};base64,{encoded}"/>')
        else:
            parts.append(f"(image: {match.group(1)})")
        last = match.end()
    parts.append(_inline_html(text[last:]))
    return "".join(parts)


_NOTE_NODE_CAP = 100_000


def _list_html(children, resolve_image=None) -> str:
    """Render nested list items iteratively so deep notes cannot overflow Python."""
    roots = list(children or [])
    meaningful = {}
    stack = [(child, False) for child in reversed(roots)]
    visited = 0
    while stack:
        node, expanded = stack.pop()
        if not expanded:
            visited += 1
            if visited > _NOTE_NODE_CAP:
                raise ValueError("note subtree exceeds export node limit")
            stack.append((node, True))
            stack.extend(
                (child, False)
                for child in reversed(node.get("children") or [])
            )
            continue
        content = (node.get("content") or "").strip()
        meaningful[id(node)] = bool(content) or any(
            meaningful.get(id(child), False)
            for child in node.get("children") or []
        )

    output = []
    events = [("node", child) for child in reversed(roots)]
    while events:
        event, value = events.pop()
        if event == "close":
            output.append("</ul></li>")
            continue
        if not meaningful.get(id(value), False):
            continue
        content = (value.get("content") or "").strip()
        nested = [
            child for child in value.get("children") or []
            if meaningful.get(id(child), False)
        ]
        output.append(f"<li>{_content_html(content, resolve_image)}")
        if nested:
            output.append("<ul>")
            events.append(("close", None))
            events.extend(("node", child) for child in reversed(nested))
        else:
            output.append("</li>")
    return "".join(output)


def note_html(node, resolve_image=None) -> str:
    """Convert one free-note block subtree to Zotero Memo HTML."""
    output = ""
    content = (node.get("content") or "").strip()
    if content:
        output += f"<p>{_content_html(content, resolve_image)}</p>"
    children = _list_html(node.get("children") or [], resolve_image)
    if children:
        output += f"<ul>{children}</ul>"
    return output


def highlight_memo_html(node, resolve_image=None) -> str:
    """Render an image-bearing highlight note with page and quote context."""
    props = node.get("properties") or {}
    page_number = props.get("pdf_page") or (
        props.get("pdf_position") or {}
    ).get("pageNumber")
    quote = re.sub(r"\s+", " ", props.get("quote") or "").strip()
    header_parts = []
    if page_number:
        header_parts.append(f"p.{page_number}")
    if quote:
        header_parts.append(f"“{quote[:120]}”")
    body = note_html(node, resolve_image)
    if not body:
        return ""
    header = " — ".join(header_parts)
    if not header:
        return body
    return f"<p><strong>{html_mod.escape(header, quote=False)}</strong></p>{body}"


def _person(sequence, name: str):
    item = ET.SubElement(sequence, _q("rdf", "li"))
    person = ET.SubElement(item, _q("foaf", "Person"))
    parts = name.strip().split()
    _sub(person, "foaf", "surname", parts[-1] if parts else name)
    if len(parts) > 1:
        _sub(person, "foaf", "givenName", " ".join(parts[:-1]))


def build_rdf(items: list[dict]) -> str:
    """Build Zotero RDF from normalized page-export item dictionaries."""
    root = ET.Element(_q("rdf", "RDF"))
    folder_paths = set()

    for number, item in enumerate(items, 1):
        meta = item.get("meta") or {}
        arxiv = str(meta.get("arxiv_id") or "").strip()
        venue = str(meta.get("venue") or "").strip()
        doi = str(meta.get("doi") or "").strip()
        if venue:
            element_tag, item_type = ("bib", "Article"), "journalArticle"
        elif arxiv:
            element_tag, item_type = ("rdf", "Description"), "preprint"
        else:
            element_tag, item_type = ("rdf", "Description"), "document"

        element = _sub(root, *element_tag, rdf_about=item["key"])
        _sub(element, "z", "itemType", item_type)
        if venue:
            journal_key = f"#journal_{number}"
            _sub(element, "dcterms", "isPartOf", rdf_resource=journal_key)
            journal = _sub(root, "bib", "Journal", rdf_about=journal_key)
            _sub(journal, "dc", "title", venue)
            if meta.get("volume"):
                _sub(journal, "prism", "volume", str(meta["volume"]))
            if doi:
                _sub(journal, "dc", "identifier", f"DOI {doi}")
        elif doi:
            _sub(element, "dc", "identifier", f"DOI {doi}")

        authors = meta.get("authors")
        if isinstance(authors, list) and authors:
            sequence = ET.SubElement(ET.SubElement(element, _q("bib", "authors")), _q("rdf", "Seq"))
            for name in authors:
                if str(name).strip():
                    _person(sequence, str(name))

        _sub(element, "dc", "title", item["title"])
        year = str(meta.get("year") or "").strip()
        if year:
            _sub(element, "dc", "date", year)
        if meta.get("pages"):
            _sub(element, "bib", "pages", str(meta["pages"]))
        if arxiv:
            uri = _sub(_sub(element, "dc", "identifier"), "dcterms", "URI")
            _sub(uri, "rdf", "value", f"https://arxiv.org/abs/{arxiv}")
        for tag in item.get("tags") or []:
            _sub(element, "dc", "subject", tag)

        if item.get("pdf_path"):
            attachment_key = f"#attach_{number}"
            _sub(element, "link", "link", rdf_resource=attachment_key)
            attachment = _sub(root, "z", "Attachment", rdf_about=attachment_key)
            _sub(attachment, "z", "itemType", "attachment")
            _sub(attachment, "z", "path", rdf_resource=item["pdf_path"])
            _sub(attachment, "dc", "title", "PDF")
            _sub(attachment, "link", "type", "application/pdf")

        for image_number, image in enumerate(item.get("images") or [], 1):
            image_key = f"#image_{number}_{image_number}"
            _sub(element, "link", "link", rdf_resource=image_key)
            attachment = _sub(root, "z", "Attachment", rdf_about=image_key)
            _sub(attachment, "z", "itemType", "attachment")
            _sub(attachment, "z", "path", rdf_resource=image["path"])
            _sub(attachment, "dc", "title", image.get("title") or "Image")
            _sub(
                attachment,
                "link",
                "type",
                image.get("mime") or "application/octet-stream",
            )

        for note_number, note in enumerate(item.get("notes") or [], 1):
            if isinstance(note, dict):
                memo_key = note["key"]
                html = note["html"]
            else:
                memo_key = f"#note_{number}_{note_number}"
                html = note
            _sub(element, "dcterms", "isReferencedBy", rdf_resource=memo_key)
            memo = _sub(root, "bib", "Memo", rdf_about=memo_key)
            _sub(memo, "rdf", "value", html)

        for path in item.get("folders") or []:
            parts = [part for part in path.split("/") if part]
            for index in range(len(parts)):
                folder_paths.add("/".join(parts[: index + 1]))

    collection_ids = {
        path: f"#collection_{index}" for index, path in enumerate(sorted(folder_paths), 1)
    }
    for path in sorted(folder_paths):
        collection = _sub(root, "z", "Collection", rdf_about=collection_ids[path])
        _sub(collection, "dc", "title", path.rsplit("/", 1)[-1])
        for child in sorted(folder_paths):
            if child != path and child.rsplit("/", 1)[0] == path:
                _sub(collection, "dcterms", "hasPart", rdf_resource=collection_ids[child])
        for item in items:
            if path in (item.get("folders") or []):
                _sub(collection, "dcterms", "hasPart", rdf_resource=item["key"])

    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode")
