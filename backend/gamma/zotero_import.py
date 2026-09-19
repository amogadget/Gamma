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
    {key, title, meta, tags, folders, pdf_paths, notes}."""
    root = ET.fromstring(text)
    attachments, memos, containers, collections = {}, {}, {}, {}
    raw_items = []
    for el in root:
        about = el.get(f"{_RDF}about") or ""
        item_type = (el.findtext(f"{_Z}itemType") or "").strip()
        if el.tag == f"{_Z}Collection":
            collections[about] = {
                "title": (el.findtext(f"{_DC}title") or "").strip() or "untitled",
                "parts": [p.get(f"{_RDF}resource") for p in el.findall(f"{_DCT}hasPart")],
            }
        elif el.tag == f"{_Z}Attachment" or item_type == "attachment":
            path_el = el.find(f"{_Z}path")
            attachments[about] = {
                "path": (path_el.get(f"{_RDF}resource") if path_el is not None else "") or "",
                "mime": (el.findtext(f"{_LINK}type") or "").strip(),
            }
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
        for ln in el.findall(f"{_LINK}link"):
            att = attachments.get(ln.get(f"{_RDF}resource") or "")
            if att and att["path"] and (
                att["mime"] == "application/pdf" or att["path"].lower().endswith(".pdf")
            ):
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
            cand = cand.replace("\\", "/")
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
        full = (f"{base}/{cand}" if base else cand).replace("\\", "/")
        for form in ("NFC", "NFD"):
            real = name_map.get(unicodedata.normalize(form, full))
            if real:
                return real
    return None
