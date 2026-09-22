"""Parse a Zotero RDF library export into plain dicts the import endpoint acts on.

The source is Zotero's File → Export Library → "Zotero RDF" (with "Export
Files" and "Export Notes"): a .rdf file plus a files/<n>/<name>.pdf tree, which
the user zips and uploads. The RDF is item-centric — bibliographic elements
(bib:Article, bib:Book, rdf:Description for preprints, …) reference
z:Attachment elements (the files) via link:link and bib:Memo elements (the
notes) via dcterms:isReferencedBy; z:Collection elements list their members
(items AND child collections) via dcterms:hasPart. Annotations made in
Zotero's reader are NOT in the RDF: "Include Annotations" embeds them into the
exported PDF copies, where the existing embedded-annotations importer
(routers/imports.py) picks them up.

Collections map onto Gamma's folder labels (both are trees, both allow an item
in several places), Zotero tags onto flat labels. Segment cleaning is the
shared gamma/foldertags.py rule (the frontend's cleanFolderSegment).
"""

import html as html_mod
import posixpath
import re
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET

from .foldertags import clean_segment

_RDF = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}"
_Z = "{http://www.zotero.org/namespaces/export#}"
_DC = "{http://purl.org/dc/elements/1.1/}"
_DCT = "{http://purl.org/dc/terms/}"
_BIB = "{http://purl.org/net/biblio#}"
_FOAF = "{http://xmlns.com/foaf/0.1/}"
_LINK = "{http://purl.org/rss/1.0/modules/link/}"
_PRISM = "{http://prismstandard.org/namespaces/1.2/basic/}"

# Same id shape as routers/metadata.py's _ARXIV_URL_RE — keep the two in sync.
_ARXIV_URL_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})", re.I)
# Zotero records arXiv preprints with a DataCite DOI: 10.48550/arXiv.<id>
_ARXIV_DOI_RE = re.compile(r"^10\.48550/arxiv\.([0-9]{4}\.[0-9]{4,5})$", re.I)


def html_note_text(html_text: str) -> str:
    """Zotero notes are HTML; reduce to the markdown-ish plain text Gamma
    blocks hold. Deliberately minimal: paragraph/list structure and bold/italic
    survive, everything else is stripped."""
    s = html_text or ""
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", "", s)
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"(?i)</(p|div|li|h[1-6]|blockquote|tr)>", "\n", s)
    s = re.sub(r"(?i)<li[^>]*>", "- ", s)
    s = re.sub(r"(?is)<(strong|b)\b[^>]*>(.*?)</\1>", r"**\2**", s)
    s = re.sub(r"(?is)<(em|i)\b[^>]*>(.*?)</\1>", r"*\2*", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html_mod.unescape(s)
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _identifiers(el) -> list[str]:
    """dc:identifier values: plain text ("DOI 10.…", "ISSN …") and the nested
    dcterms:URI/rdf:value form both occur."""
    out = []
    for ident in el.findall(f"{_DC}identifier"):
        if ident.text and ident.text.strip():
            out.append(ident.text.strip())
        v = ident.find(f"{_DCT}URI/{_RDF}value")
        if v is not None and v.text:
            out.append(v.text.strip())
    return out


def _container_fields(el) -> dict:
    return {
        "venue": (el.findtext(f"{_DC}title") or "").strip(),
        "volume": (el.findtext(f"{_PRISM}volume") or "").strip(),
        "idents": _identifiers(el),
    }


def _doi_from(idents: list[str]) -> str:
    return next((i[4:].strip() for i in idents if i.upper().startswith("DOI ")), "")


def parse_zotero_rdf(text: str) -> list[dict]:
    """→ one dict per bibliographic item:
    {key, title, meta, tags, folders, pdf_paths, notes}. Includes standalone PDFs."""
    root = ET.fromstring(text)
    attachments, memos, containers, collections = {}, {}, {}, {}
    raw_items = []
    attachment_elements = {}
    # Attachments can be top-level resources or inline link:link children.
    for el in root.iter():
        if el.tag != f"{_Z}Attachment" and el.findtext(f"{_Z}itemType") != "attachment":
            continue
        about = el.get(f"{_RDF}about") or ""
        path_el = el.find(f"{_Z}path")
        path = ((path_el.get(f"{_RDF}resource") or path_el.text or "")
                if path_el is not None else "").strip()
        mime = (el.findtext(f"{_LINK}type") or el.findtext(f"{_DCT}type") or "").strip().lower()
        attachments[about] = {"path": path, "pdf": mime == "application/pdf" or path.lower().endswith(".pdf")}
        attachment_elements[about] = el
    for el in root:
        about = el.get(f"{_RDF}about") or ""
        item_type = (el.findtext(f"{_Z}itemType") or "").strip()
        if el.tag == f"{_Z}Collection":
            collections[about] = {
                "title": (el.findtext(f"{_DC}title") or "").strip() or "untitled",
                "parts": [p.get(f"{_RDF}resource") for p in el.findall(f"{_DCT}hasPart")],
            }
        elif el.tag == f"{_Z}Attachment" or item_type == "attachment":
            pass
        elif el.tag == f"{_BIB}Memo" or item_type == "note":
            memos[about] = el.findtext(f"{_RDF}value") or ""
        elif item_type:
            raw_items.append((about, el))
        elif about:
            # standalone container records (bib:Journal …) referenced via isPartOf
            containers[about] = _container_fields(el)

    # Collection tree → path per collection (hasPart links child collections)
    parent_of = {}
    for key, col in collections.items():
        for part in col["parts"]:
            if part in collections:
                parent_of[part] = key

    def col_path(key):
        parts, seen = [], set()
        while key in collections and key not in seen:
            seen.add(key)  # cycle guard — malformed exports shouldn't hang us
            parts.append(clean_segment(collections[key]["title"]) or "untitled")
            key = parent_of.get(key)
        return "/".join(reversed(parts))

    item_folders = {}
    for key, col in collections.items():
        path = col_path(key)
        for part in col["parts"]:
            if part not in collections and path:
                item_folders.setdefault(part, []).append(path)

    def linked_attachments(el):
        for link in el.findall(f"{_LINK}link"):
            ref = link.get(f"{_RDF}resource")
            if ref:
                yield ref
            else:
                for child in link:
                    yield child.get(f"{_RDF}about") or ""

    linked = {key for _, el in raw_items for key in linked_attachments(el)}
    raw_items.extend((key, el) for key, el in attachment_elements.items()
                     if key not in linked and attachments[key]["pdf"])
    items = []
    for about, el in raw_items:
        authors = []
        for person in el.findall(f"{_BIB}authors//{_FOAF}Person"):
            name = " ".join(filter(None, [
                (person.findtext(f"{_FOAF}givenName") or "").strip(),
                (person.findtext(f"{_FOAF}surname") or "").strip(),
            ]))
            if name:
                authors.append(name)

        idents = _identifiers(el)
        url = next((i for i in idents if i.lower().startswith("http")), "")
        if not url and about.lower().startswith("http"):
            url = about
        doi = _doi_from(idents)

        # venue/volume come from the journal record — inline child or a
        # standalone element referenced by rdf:resource. Zotero puts the
        # article's DOI on that journal record, not on the item itself.
        container = {}
        part_el = el.find(f"{_DCT}isPartOf")
        if part_el is not None:
            ref = part_el.get(f"{_RDF}resource")
            if ref:
                container = containers.get(ref, {})
            elif len(part_el):
                container = _container_fields(part_el[0])
        if not doi:
            doi = _doi_from(container.get("idents", []))

        year_match = re.search(r"\d{4}", el.findtext(f"{_DC}date") or "")
        arxiv_id = ""
        m = _ARXIV_URL_RE.search(url)
        if m:
            arxiv_id = m.group(1)
        elif doi:
            m = _ARXIV_DOI_RE.match(doi)
            if m:
                arxiv_id = m.group(1)

        title = re.sub(r"\s+", " ", el.findtext(f"{_DC}title") or "").strip()
        meta = {
            "title": title,
            "authors": authors,
            "year": year_match.group(0) if year_match else "",
            "venue": container.get("venue", ""),
            "volume": container.get("volume", "") or (el.findtext(f"{_PRISM}volume") or "").strip(),
            "pages": (el.findtext(f"{_BIB}pages") or "").strip(),
            "doi": doi,
            "arxiv_id": arxiv_id,
            "source": "zotero",
        }

        tags = []
        for s in el.findall(f"{_DC}subject"):
            # plain text, or nested <z:AutomaticTag><rdf:value>…</rdf:value>
            t = (s.text or "").strip() or (s.findtext(f".//{_RDF}value") or "").strip()
            t = t.replace(",", " ").strip()
            if t and t not in tags:
                tags.append(t)

        pdf_paths = []
        keys = [about] if about in attachments else list(linked_attachments(el))
        for key in keys:
            att = attachments.get(key)
            if att and att["path"] and att["pdf"] and att["path"] not in pdf_paths:
                pdf_paths.append(att["path"])

        notes = []
        for ref in el.findall(f"{_DCT}isReferencedBy"):
            key = ref.get(f"{_RDF}resource") or ""
            if key in memos:
                note_text = html_note_text(memos[key])
                if note_text:
                    notes.append({"key": key, "text": note_text})

        items.append({
            "key": about,
            "title": title or "Untitled",
            "meta": meta,
            "tags": tags,
            "folders": item_folders.get(about, []),
            "pdf_paths": pdf_paths,
            "notes": notes,
        })
    return items


def zip_name_map(zf) -> dict:
    """Candidate spelling → real entry name, tolerant of what zippers actually
    produce: Explorer omits the UTF-8 flag so non-ASCII names arrive as
    cp437 mojibake, some tools write backslash separators, and macOS stores
    NFD-decomposed unicode."""
    out = {}
    for zi in zf.infolist():
        cands = {zi.filename}
        if not (zi.flag_bits & 0x800):  # no UTF-8 flag: zipfile decoded cp437
            try:
                cands.add(zi.filename.encode("cp437").decode("utf-8"))
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
        for cand in list(cands):
            cand = posixpath.normpath(cand.replace("\\", "/"))
            for form in ("NFC", "NFD"):
                out[unicodedata.normalize(form, cand)] = zi.filename
    return out


def find_zip_entry(name_map: dict, base: str, path: str) -> str | None:
    """Resolve a z:path (relative to the .rdf file) to a real zip entry name.
    The path attribute is usually raw, but try percent-decoding too."""
    seen = []
    for cand in (path, urllib.parse.unquote(path)):
        if cand in seen:
            continue
        seen.append(cand)
        full = posixpath.normpath((f"{base}/{cand}" if base else cand).replace("\\", "/"))
        for form in ("NFC", "NFD"):
            real = name_map.get(unicodedata.normalize(form, full))
            if real:
                return real
    return None


def resolve_pdf_entry(name_map: dict, base: str, path: str) -> tuple[str | None, bool]:
    """Exact path first; a renamed PDF may only match inside its attachment folder.

    Never guess by basename across the archive: different items often use PDF.pdf.
    A unique PDF in files/<attachment-id> is safe even after filename truncation
    or a legacy ZIP encoding changed its spelling.
    """
    exact = find_zip_entry(name_map, base, path)
    if exact:
        return exact, False
    candidates = set()
    for spelling in (path, urllib.parse.unquote(path)):
        parent = posixpath.dirname(posixpath.normpath(spelling.replace("\\", "/")))
        if not re.search(r"(?:^|/)files/[^/]+$", parent):
            continue
        target = posixpath.normpath(f"{base}/{parent}" if base else parent)
        for name, real in name_map.items():
            if posixpath.dirname(name) == target and name.lower().endswith(".pdf"):
                candidates.add(real)
    return (next(iter(candidates)), True) if len(candidates) == 1 else (None, False)


def plan_zotero_archive(zf) -> dict:
    """Read-only plan shared by preview and import; PDF bytes stay in the ZIP."""
    from .storage import content_digest, is_pdf

    names = zip_name_map(zf)
    rdf_names = [n for n in names if n.lower().endswith(".rdf") and not n.startswith("__MACOSX/")]
    if not rdf_names:
        raise ValueError('no .rdf file in the zip — export from Zotero as "Zotero RDF" with "Export Files"')
    rdf_name = min(rdf_names, key=lambda n: (n.count("/"), len(n), n))
    base = posixpath.dirname(rdf_name)
    items = parse_zotero_rdf(zf.read(names[rdf_name]).decode("utf-8-sig"))
    if not items:
        raise ValueError("no importable items in the export")
    warnings, planned, used = [], [], {names[rdf_name]}
    for item in items:
        problems, valid = [], []
        for path in item["pdf_paths"]:
            real, recovered = resolve_pdf_entry(names, base, path)
            if not real:
                problems.append({"title": item["title"], "path": path, "reason": f"PDF missing from ZIP: {path}"})
                continue
            try:
                data = zf.read(real)
                if not is_pdf(data):
                    raise ValueError("file is not a PDF")
                digest = content_digest(data)
            except Exception as exc:
                problems.append({"title": item["title"], "path": real, "reason": f"Cannot import PDF: {exc}"})
                continue
            used.add(real)
            valid.append((path, real, digest))
            if recovered:
                problems.append({"title": item["title"], "path": real,
                                 "reason": f"Filename differs from the export; matched the only PDF in its attachment folder: {real}"})
        if not valid:
            problems.append({"title": item["title"], "reason": "No PDF available in this ZIP. New pages contain metadata and notes only; existing PDFs are kept."})
        item["warnings"] = problems
        item["pdf_entry"] = valid[0][1] if valid else None
        item["digest"] = valid[0][2] if valid else None
        planned.append(item)
        # A Gamma page has one PDF. Preserve additional PDFs as separate pages
        # in the same collections, with stable keys on subsequent imports.
        for path, real, digest in valid[1:]:
            title = f"{item['title']} — {posixpath.basename(path.replace(chr(92), '/'))}"
            extra = {**item, "key": f"{item['key']}#pdf:{path}", "title": title,
                     "meta": {**item["meta"], "title": title}, "notes": [],
                     "pdf_paths": [path], "pdf_entry": real, "digest": digest, "warnings": []}
            planned.append(extra)
            problems.append({"title": item["title"], "path": real,
                             "reason": "Additional PDF imports as a separate page in the same folders."})
        warnings.extend(problems)
    entries = []
    for zi in zf.infolist():
        path = zi.filename.replace("\\", "/")
        directory = path.endswith("/")
        status = "folder" if directory else "imported" if zi.filename in used else "not_imported"
        entries.append({"path": path, "size": zi.file_size, "directory": directory, "status": status})
        if status == "not_imported" and not path.startswith("__MACOSX/") and not path.endswith(".DS_Store"):
            warnings.append({"title": posixpath.basename(path), "path": path,
                             "reason": "File is not imported: unsupported attachment or not linked to an item in the selected export."})
    for index, item in enumerate(planned):
        item["selection_id"] = f"zotero:{index}"
        for warning in item["warnings"]:
            warning["selection_id"] = item["selection_id"]
    return {"items": planned, "entries": entries, "warnings": warnings, "manifest": rdf_name}
