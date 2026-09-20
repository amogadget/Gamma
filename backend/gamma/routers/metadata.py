"""Paper metadata + citations.

Lookup order: arXiv API (id from the source URL or the PDF text) → DOI via
doi.org content negotiation (Crossref/DataCite) → ISBN printed in the PDF via
Open Library / Google Books (books) → Crossref bibliographic search on the
text head → AI extraction from the first pages as a last resort, itself
cross-checked against Crossref and, for books, the book registries.
A registry record found via the *text* (not the source URL) is only trusted
outright when its title actually appears in the PDF — the first DOI on page 1
can belong to a cited paper, and AI output can be a plausible hallucination.
Whatever is stored carries ``meta.unverified`` so the UI can warn before the
record ends up in a paper's bibliography. There is deliberately no Google
Scholar call — Scholar has no official API and scraping it violates its ToS.
Results are cached on the page block (properties.meta / properties.bibtex /
properties.ppt_cite — the slide citation is generated in the same fetch).
"""

import json
import re
import sqlite3
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from difflib import SequenceMatcher

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import ai_usage
from ..ai_client import call_ai as _call_ai
from ..ai_context import ensure_indexed as _ensure_indexed
from ..ai_context import pdf_excerpt as _pdf_excerpt
from ..ai_context import pdf_path as _pdf_path
from ..ai_settings import ai_runtime, require_ai_runtime
from ..auth import require_ws
from ..blocks_store import page_attachment
from ..ops import after_commit, apply_ops, props_patch
from ..db import connect_pages_db, page_now, ws_db_path, ws_uploads_dir
from ..logbuf import log
from ..pdf_text import PDF_EXTRACT_FAILED
from ..pdf_text import page_count as _page_count
from ..textnorm import INDEX_VERSION, normalize_text
from .ai import CITE_PROMPT, METADATA_PROMPT, _resolve_model
from .pdf import CONTACT_EMAIL

# Guards the doc-id → filename join below (defense in depth: doc ids come from
# block properties a user can set). Mirrors gamma.db._DOC_ID_RE.
_DOC_ID_OK = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")

router = APIRouter(prefix="/api", tags=["metadata"])

# How much text identifier scans and title matching read. Decoupled from the
# AI context pref: an issue-clipped Science PDF starts with the *previous*
# article's tail, and the paper's own title/DOI can sit 7k+ chars in — a
# window sized for AI cost must not starve the free regex/matching steps.
SCAN_CHARS = 20000

# New-style (2101.01234) and old-style (cond-mat/0501234) arXiv ids
_ARXIV_ID = r"([0-9]{4}\.[0-9]{4,5}|[a-z][a-z.-]*/[0-9]{7})"
_ARXIV_URL_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/" + _ARXIV_ID, re.I)
_ARXIV_TEXT_RE = re.compile(r"arXiv:\s*" + _ARXIV_ID, re.I)
_DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"'<>]+)")
_ATOM = "{http://www.w3.org/2005/Atom}"
_ARXIV_NS = "{http://arxiv.org/schemas/atom}"


def _http_get(url: str, accept: str = "", timeout: int = 20) -> bytes:
    headers = {"User-Agent": "gamma-pdf-annotator/1.0 (metadata lookup)"}
    if accept:
        headers["Accept"] = accept
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _find_arxiv_id(source_url: str, text: str) -> str:
    m = _ARXIV_URL_RE.search(source_url or "") or _ARXIV_TEXT_RE.search(text or "")
    return m.group(1) if m else ""


def _doi_variants(doi: str) -> list[str]:
    """A DOI plus a trimmed variant when PDF text extraction glued the next
    word straight onto it ("…-0478-8Physics Department"): a trailing
    all-letters run after a digit yields the second, trimmed candidate."""
    doi = doi.rstrip(".,;)]}’”")
    out = [doi]
    glued = re.match(r"^(.*\d)([A-Za-z]{3,})$", doi)
    if glued and glued.group(1) not in out:
        out.append(glued.group(1))
    return out


def _find_doi_candidates(source_url: str, text: str) -> list[str]:
    """Every DOI in the source URL and text head, most likely first (URL before
    text, then reading order), each followed by its glued-suffix trim."""
    cands: list[str] = []
    for hay in (source_url or "", text or ""):
        for m in _DOI_RE.finditer(hay):
            for cand in _doi_variants(m.group(1)):
                if cand not in cands:
                    cands.append(cand)
            if len(cands) >= 8:
                return cands
    return cands


def _norm_match(s: str) -> str:
    """Case/punctuation/ligature/line-break-insensitive form for title
    matching (normalize_text folds ligatures and unwraps hyphenated breaks)."""
    return " ".join(re.findall(r"[a-z0-9]+", normalize_text(s or "").lower()))


def _title_in_text(title: str, text: str) -> bool:
    """Does this (registry) title literally appear in the PDF's text head?
    The strongest evidence a looked-up record describes *this* paper. Short
    titles are too generic to count."""
    t = _norm_match(title)
    return len(t) >= 15 and t in _norm_match((text or "")[:SCAN_CHARS])


def _years_compatible(a, b) -> bool:
    ma, mb = re.search(r"\d{4}", str(a or "")), re.search(r"\d{4}", str(b or ""))
    return not ma or not mb or abs(int(ma.group()) - int(mb.group())) <= 1


def _surname(author: str) -> str:
    """Last alphabetic token of an author string ("Anthony E. Siegman" →
    "siegman"), normalized like the text it is matched against."""
    parts = re.findall(r"[a-z]+", normalize_text(author or "").lower())
    return parts[-1] if parts and len(parts[-1]) >= 3 else ""


def _record_in_text(meta: dict, text: str) -> bool:
    """Book-strength evidence that a registry record describes this PDF: a
    long title in the text (the paper rule), or — book titles are short
    ("Lasers") — the whole title AND one author surname both in the head."""
    if _title_in_text(meta.get("title", ""), text):
        return True
    # Title pages letter-space the title ("L A S E R S"); fold runs of
    # single letters back into a word before matching.
    head = re.sub(r"\b(?:[a-z0-9] ){2,}[a-z0-9]\b", lambda m: m.group().replace(" ", ""),
                  _norm_match((text or "")[:SCAN_CHARS]))
    head = f" {head} "
    t = _norm_match(meta.get("title", ""))
    if len(t) < 4 or f" {t} " not in head:
        return False
    return any(f" {s} " in head for s in map(_surname, meta.get("authors") or []) if s)


# --- Books ------------------------------------------------------------------
# Papers resolve through arXiv/DOI/Crossref; books mostly don't (Crossref only
# knows DOI-registered ones, and an old textbook has neither). Two keyless
# book registries cover them: Open Library and Google Books. Entry points: an
# ISBN printed in the PDF (copyright page, back cover), or the AI-read title +
# author of a book that predates ISBNs.

_ISBN_RE = re.compile(r"ISBN(?:-1[03])?\s*[:：]?\s*([0-9][0-9Xx\s‐-―-]{8,22}[0-9Xx])", re.I)
# Shorter than the paper registries: both book APIs are optional extras on a
# path that has already tried arXiv/DOI, and Open Library can be slow or
# unreachable from some networks — a fetch must not hang on them.
_BOOK_API_TIMEOUT = 8


def _isbn_valid(digits: str) -> bool:
    if len(digits) == 10 and re.fullmatch(r"\d{9}[\dX]", digits):
        return sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(digits)) % 11 == 0
    if len(digits) == 13 and digits.isdigit():
        return sum((1 if i % 2 == 0 else 3) * int(c) for i, c in enumerate(digits)) % 10 == 0
    return False


def _find_isbns(text: str) -> list[str]:
    """Checksum-valid ISBNs labelled "ISBN" in the text, reading order. Only
    labelled ones — a bare 10/13-digit run is a phone number or a DOI tail.
    Extraction glues the next number on ("ISBN 0-935702-11-3 1986"), so the
    13- (978/979-prefixed) and 10-character prefixes are both tried."""
    out: list[str] = []
    for m in _ISBN_RE.finditer(text or ""):
        digits = re.sub(r"[^0-9Xx]", "", m.group(1)).upper()
        cands = ([digits[:13]] if digits[:3] in ("978", "979") else []) + [digits[:10]]
        for cand in cands:
            if _isbn_valid(cand) and cand not in out:
                out.append(cand)
                break
        if len(out) >= 4:
            break
    return out


def _book_record(title: str, authors: list, year, publisher: str, isbns: list,
                 source: str, years: list | None = None) -> dict | None:
    title = re.sub(r"\s+", " ", str(title or "")).strip()
    if not title:
        return None
    ym = re.search(r"\d{4}", str(year or ""))
    isbns = [re.sub(r"[^0-9Xx]", "", str(i)).upper() for i in (isbns or [])]
    isbns = [i for i in isbns if _isbn_valid(i)]
    return {
        "title": title,
        "authors": [str(a).strip() for a in (authors or []) if str(a).strip()],
        "year": ym.group() if ym else "",
        "venue": "", "volume": "", "pages": "",
        "doi": "", "arxiv_id": "",
        "publisher": re.sub(r"\s+", " ", str(publisher or "")).strip(),
        # Edition-specific: only meaningful when the PDF in hand printed it
        # (the ISBN step) — search hits keep the candidates in "isbns" and
        # _pick_book_match adopts one only if the text contains it.
        "isbn": "",
        "isbns": isbns,
        "years": [str(y) for y in (years or []) if str(y).strip()],
        "kind": "book",
        "source": source,
    }


def _gb_record(info: dict, source: str) -> dict | None:
    """One Google Books volumeInfo → record. Subtitles stay separate (a
    citation wants the main title)."""
    return _book_record(
        info.get("title"), info.get("authors") or [], info.get("publishedDate"),
        info.get("publisher"),
        [i.get("identifier") for i in (info.get("industryIdentifiers") or []) if str(i.get("type", "")).startswith("ISBN")],
        source, years=[str(info.get("publishedDate") or "")[:4]])


def _fetch_isbn(isbn: str) -> dict | None:
    """Resolve one ISBN: Open Library's books API, then Google Books."""
    try:
        data = json.loads(_http_get(
            f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data",
            timeout=_BOOK_API_TIMEOUT,
        )).get(f"ISBN:{isbn}") or {}
    except Exception as e:
        log.warning(f"[metadata] openlibrary isbn lookup failed: {e}")
        data = {}
    rec = _book_record(
        data.get("title"), [a.get("name") for a in (data.get("authors") or [])],
        data.get("publish_date"), (data.get("publishers") or [{}])[0].get("name"),
        [isbn], "isbn") if data else None
    if not rec:
        try:
            items = json.loads(_http_get(
                "https://www.googleapis.com/books/v1/volumes?q=isbn:" + isbn,
                timeout=_BOOK_API_TIMEOUT)).get("items") or []
        except Exception as e:
            log.warning(f"[metadata] google books isbn lookup failed: {e}")
            items = []
        rec = next((r for r in (_gb_record(it.get("volumeInfo") or {}, "isbn") for it in items) if r), None)
    if rec:
        rec["isbn"] = isbn
        rec.pop("isbns", None)
        rec.pop("years", None)
    return rec


def _book_search(title: str, author: str = "") -> list[dict]:
    """Title(+author) search over Open Library then Google Books, up to five
    candidates each in that order. Not trusted as-is — _pick_book_match
    decides."""
    if not (title or "").strip():
        return []
    out: list[dict] = []
    q = {"title": title[:200], "limit": "5",
         "fields": "title,author_name,first_publish_year,publish_year,publisher,isbn"}
    if author:
        q["author"] = author[:100]
    try:
        docs = json.loads(_http_get("https://openlibrary.org/search.json?" + urllib.parse.urlencode(q),
                                    timeout=_BOOK_API_TIMEOUT)).get("docs") or []
    except Exception as e:
        log.warning(f"[metadata] openlibrary search failed: {e}")
        docs = []
    for d in docs:
        rec = _book_record(d.get("title"), d.get("author_name") or [], d.get("first_publish_year"),
                           (d.get("publisher") or [""])[0], d.get("isbn") or [], "openlibrary",
                           years=d.get("publish_year") or [])
        if rec:
            out.append(rec)
    gq = f'intitle:"{title[:200]}"' + (f' inauthor:"{author[:100]}"' if author else "")
    try:
        items = json.loads(_http_get(
            "https://www.googleapis.com/books/v1/volumes?maxResults=%d&q=%s" % (rows, urllib.parse.quote(gq)),
            timeout=_BOOK_API_TIMEOUT,
        )).get("items") or []
    except Exception as e:
        log.warning(f"[metadata] google books search failed: {e}")
        items = []
    for it in items:
        rec = _gb_record(it.get("volumeInfo") or {}, "googlebooks")
        if rec:
            out.append(rec)
    return out


def _titles_alike(a: str, b: str) -> bool:
    """Normalized titles near-identical, or one is the other plus a subtitle."""
    if not a or not b:
        return False
    short, long_ = sorted((a, b), key=len)
    return a == b or SequenceMatcher(None, a, b).ratio() >= 0.9 or (len(short) >= 15 and long_.startswith(short))


def _pick_book_match(cands: list[dict], text: str, ai_meta: dict | None = None) -> dict | None:
    """Accept a book-registry hit only on strong evidence: its title matches
    the AI-read title AND an author surname agrees (both were read off the
    PDF, the registry confirms they name a real book), or — without AI — the
    title and an author appear in the text. The AI-read year wins over the
    registry's first-publication year: it names the edition in hand. An ISBN
    is adopted only when the PDF text prints it."""
    ai_title = _norm_match((ai_meta or {}).get("title", ""))
    ai_names = {s for s in map(_surname, (ai_meta or {}).get("authors") or []) if s}
    ai_year = str((ai_meta or {}).get("year") or "").strip()
    text_digits = re.sub(r"[^0-9Xx]", "", (text or "")[:SCAN_CHARS]).upper()
    passes = ([lambda c: _titles_alike(_norm_match(c["title"]), ai_title)
               and bool(ai_names & {s for s in map(_surname, c.get("authors") or []) if s})]
              if ai_title else []) + [lambda c: _record_in_text(c, text)]
    for accept in passes:
        for cand in cands:
            if not accept(cand):
                continue
            rec = {k: v for k, v in cand.items() if k not in ("isbns", "years")}
            rec["isbn"] = next((i for i in cand.get("isbns") or [] if i in text_digits), "")
            if ai_year:
                rec["year"] = ai_year
            return rec
    return None


_REGISTRY_CACHE: dict[str, dict] = {}
_REGISTRY_CACHE_MAX = 200


def registry_record(doi: str, arxiv_id: str) -> dict | None:
    """The registry record behind an identifier: arXiv first (its record
    carries the published DOI too), then doi.org. None when neither answers.
    Hits are cached in memory (the data is public); a registry timeout is
    transient and never remembered. Serves the extension's preview."""
    cache_key = f"arxiv:{arxiv_id}" if arxiv_id else f"doi:{doi}"
    if cache_key in _REGISTRY_CACHE:
        return _REGISTRY_CACHE[cache_key]
    meta = _fetch_arxiv(arxiv_id) if arxiv_id else None
    if not meta and doi:
        meta, _ = _fetch_doi(doi, with_bibtex=False)
    if meta:
        if len(_REGISTRY_CACHE) >= _REGISTRY_CACHE_MAX:
            _REGISTRY_CACHE.pop(next(iter(_REGISTRY_CACHE)))
        _REGISTRY_CACHE[cache_key] = meta
    return meta


def _arxiv_entry_meta(entry, arxiv_id: str = "") -> dict | None:
    """One Atom entry of the arXiv API as a meta dict (None for the API's
    "Error" entry). arxiv_id defaults to the entry's own id, version
    stripped."""
    title = re.sub(r"\s+", " ", entry.findtext(f"{_ATOM}title") or "").strip()
    if not title or title.lower() == "error":
        return None
    if not arxiv_id:
        m = re.search(r"arxiv\.org/abs/(.+?)(?:v\d+)?$", (entry.findtext(f"{_ATOM}id") or "").strip())
        arxiv_id = m.group(1) if m else ""
    authors = [
        (a.findtext(f"{_ATOM}name") or "").strip()
        for a in entry.findall(f"{_ATOM}author")
    ]
    journal_ref = (entry.findtext(f"{_ARXIV_NS}journal_ref") or "").strip()
    return {
        "title": title,
        "authors": [a for a in authors if a],
        "year": (entry.findtext(f"{_ATOM}published") or "")[:4],
        "venue": journal_ref or f"arXiv:{arxiv_id}",
        "volume": "",
        "pages": "",
        "doi": (entry.findtext(f"{_ARXIV_NS}doi") or "").strip(),
        "arxiv_id": arxiv_id,
        "source": "arxiv",
    }


def _fetch_arxiv(arxiv_id: str) -> dict | None:
    try:
        raw = _http_get(f"https://export.arxiv.org/api/query?id_list={urllib.parse.quote(arxiv_id)}")
        entry = ET.fromstring(raw).find(f"{_ATOM}entry")
        if entry is None:
            return None
        return _arxiv_entry_meta(entry, arxiv_id)
    except Exception as e:
        log.warning(f"[metadata] arxiv lookup failed: {e}")
        return None


def _arxiv_search(query: str, rows: int = 5) -> list[dict]:
    """Full-record search of the arXiv API (title, authors, abstract — every
    word ANDed), candidates in arXiv's relevance order. Keyless, like the
    Crossref search; the agent's search_papers queries both."""
    words = [w for w in re.findall(r"[\w-]+", query or "") if len(w) > 1][:12]
    if not words:
        return []
    url = ("https://export.arxiv.org/api/query?max_results=%d&search_query=" % rows
           + urllib.parse.quote(" AND ".join(f"all:{w}" for w in words)))
    try:
        entries = ET.fromstring(_http_get(url)).findall(f"{_ATOM}entry")
    except Exception as e:
        log.warning(f"[metadata] arxiv search failed: {e}")
        return []
    return [meta for meta in (_arxiv_entry_meta(e) for e in entries) if meta]


def _fetch_doi(doi: str, with_bibtex: bool = True) -> tuple[dict | None, str]:
    """Metadata via doi.org content negotiation (works for Crossref and DataCite),
    plus the registrar's own BibTeX rendering (a second round trip — skipped
    by callers that only want the record, e.g. the extension's preview)."""
    url = f"https://doi.org/{urllib.parse.quote(doi)}"
    try:
        data = json.loads(_http_get(url, accept="application/vnd.citationstyles.csl+json"))
    except Exception as e:
        log.warning(f"[metadata] doi lookup failed: {e}")
        return None, ""
    title = data.get("title") or ""
    if isinstance(title, list):
        title = title[0] if title else ""
    if not title:
        return None, ""
    date_parts = ((data.get("issued") or {}).get("date-parts") or [[None]])[0]
    meta = {
        "title": re.sub(r"\s+", " ", str(title)).strip(),
        "authors": [
            " ".join(filter(None, [a.get("given"), a.get("family")])).strip()
            for a in (data.get("author") or [])
        ],
        "year": str(date_parts[0] or ""),
        "venue": str(data.get("container-title") or ""),
        "volume": str(data.get("volume") or ""),
        "pages": str(data.get("page") or ""),
        "doi": doi,
        "arxiv_id": "",
        "source": "doi",
    }
    if str(data.get("type") or "") in ("book", "monograph"):
        # A DOI-registered book: keep it a book so BibTeX says @book.
        isbns = data.get("ISBN") or []
        meta.update({"kind": "book", "publisher": str(data.get("publisher") or ""),
                     "isbn": str(isbns[0] if isinstance(isbns, list) and isbns else "")})
    bibtex = ""
    if with_bibtex:
        try:
            bibtex = _http_get(url, accept="application/x-bibtex").decode("utf-8", "replace").strip()
        except Exception:
            pass
    return meta, bibtex


def _crossref_search(query: str, rows: int = 5) -> list[dict]:
    """Bibliographic search against the Crossref REST API, returning candidate
    meta dicts in Crossref's relevance order. Candidates are NOT trusted as-is
    — _pick_crossref_match decides whether one matches this paper."""
    if not (query or "").strip():
        return []
    url = ("https://api.crossref.org/works?rows=%d" % rows
           + "&select=DOI,title,author,container-title,volume,page,issued"
           + "&mailto=" + urllib.parse.quote(CONTACT_EMAIL)
           + "&query.bibliographic=" + urllib.parse.quote(query[:400]))
    try:
        items = json.loads(_http_get(url)).get("message", {}).get("items", [])
    except Exception as e:
        log.warning(f"[metadata] crossref search failed: {e}")
        return []
    out = []
    for it in items:
        title = (it.get("title") or [""])[0]
        if not title:
            continue
        date_parts = ((it.get("issued") or {}).get("date-parts") or [[None]])[0]
        out.append({
            "title": re.sub(r"\s+", " ", str(title)).strip(),
            "authors": [
                " ".join(filter(None, [a.get("given"), a.get("family")])).strip()
                for a in (it.get("author") or [])
            ],
            "year": str(date_parts[0] or ""),
            "venue": str((it.get("container-title") or [""])[0] or ""),
            "volume": str(it.get("volume") or ""),
            "pages": str(it.get("page") or ""),
            "doi": str(it.get("DOI") or ""),
            "arxiv_id": "",
            "source": "crossref",
        })
    return out


def _pick_crossref_match(cands: list[dict], text: str, ai_meta: dict | None = None) -> dict | None:
    """Accept a Crossref search hit only on strong evidence: its exact title
    appears in the PDF text, or it is near-identical to the AI-extracted title
    with a compatible year. Anything weaker is rejected — wrong-but-plausible
    metadata is worse than none."""
    head = _norm_match((text or "")[:SCAN_CHARS])
    ai_title = _norm_match((ai_meta or {}).get("title", ""))
    for cand in cands:
        t = _norm_match(cand["title"])
        if len(t) < 15:
            continue  # "Editorial", "Errata" — too generic to trust
        if head and t in head:
            return cand
        if (ai_title and SequenceMatcher(None, t, ai_title).ratio() >= 0.92
                and _years_compatible(cand.get("year"), (ai_meta or {}).get("year"))):
            return cand
    return None


def _verify_ai_meta(meta: dict, text: str, hints: str = "") -> tuple[dict, str]:
    """AI extraction is a last resort and hallucinates plausible records
    (blended author lists, wrong volumes, fabricated DOIs — the prompt's
    "never invent" is not enforcement). Upgrade to the authoritative registry
    record when an identifier the AI produced actually resolves; otherwise
    cross-check the AI title against a Crossref search. An identifier that
    resolves nowhere and doesn't occur in the PDF text is dropped rather than
    stored — a missing DOI is recoverable, a fabricated one poisons BibTeX."""
    hay = ((hints or "") + "\n" + (text or "")[:SCAN_CHARS + 4000]).lower()
    if meta.get("arxiv_id"):
        better = _fetch_arxiv(meta["arxiv_id"])
        if better:
            return better, ""
        if meta["arxiv_id"].lower() not in hay:
            log.info(f"[metadata] dropping unresolvable AI arXiv id {meta['arxiv_id']!r}")
            meta["arxiv_id"] = ""
    if meta.get("doi"):
        for doi in _doi_variants(meta["doi"]):
            better, bib = _fetch_doi(doi)
            if better:
                return better, bib
        if meta["doi"].lower() not in hay:
            log.info(f"[metadata] dropping unresolvable AI DOI {meta['doi']!r}")
            meta["doi"] = ""
    query = " ".join(filter(None, [meta.get("title"), *(meta.get("authors") or [])[:3],
                                   meta.get("year")]))
    cand = _pick_crossref_match(_crossref_search(query), text, ai_meta=meta)
    if cand:
        better, bib = _fetch_doi(cand["doi"])
        return (better or cand), bib
    if meta.get("kind") in ("book", "other"):
        # Crossref doesn't know most books. The AI read a title and an author
        # off the title page — let the book registries confirm they name a
        # real book (and supply publisher, canonical title, ISBN).
        first_author = (meta.get("authors") or [""])[0]
        cand = _pick_book_match(_book_search(meta.get("title", ""), first_author), text, ai_meta=meta)
        if cand:
            return cand, ""
    return meta, ""


# Document kinds the AI classifier may report. Anything else (or a missing
# kind, e.g. records cached before the field existed) is treated as "paper" —
# the safe default, since only papers get the unverified-metadata warning.
_DOC_KINDS = ("paper", "notes", "slides", "thesis", "book", "report", "other")


def _ai_extract_meta(text: str, prompt: str, model: str, rt: dict) -> dict | None:
    system = (prompt or METADATA_PROMPT).strip()[:4000]
    try:
        entry = _resolve_model(rt, model)
        raw = _call_ai(
            [{"role": "user", "content": f"First pages of the paper:\n\n{text}"}],
            # Generous cap: reasoning models spend invisible tokens before the JSON
            system, entry, rt, max_tokens=8000, timeout=120,
            on_usage=ai_usage.recorder("metadata", entry, rt),
        )
        m = re.search(r"\{[\s\S]*\}", raw)
        if not m:
            return None
        data = json.loads(m.group(0))
    except Exception as e:
        log.warning(f"[metadata] AI extraction failed: {e}")
        return None
    if not (data.get("title") or "").strip():
        return None
    authors = data.get("authors") or []
    if isinstance(authors, str):
        authors = [a.strip() for a in re.split(r",| and ", authors) if a.strip()]
    kind = str(data.get("kind") or "").strip().lower()
    return {
        "title": str(data.get("title") or "").strip(),
        "authors": [str(a).strip() for a in authors if str(a).strip()],
        "year": str(data.get("year") or "").strip(),
        "venue": str(data.get("venue") or "").strip(),
        "volume": str(data.get("volume") or "").strip(),
        "pages": str(data.get("pages") or "").strip(),
        "doi": str(data.get("doi") or "").strip(),
        "arxiv_id": str(data.get("arxiv_id") or "").strip(),
        "publisher": str(data.get("publisher") or "").strip(),
        "isbn": re.sub(r"[^0-9Xx]", "", str(data.get("isbn") or "")).upper(),
        "kind": kind if kind in _DOC_KINDS else "paper",
        "source": "ai",
    }


def _build_bibtex(meta: dict) -> str:
    authors = meta.get("authors") or []
    key_author = re.sub(r"[^a-z]", "", (authors[0].split()[-1] if authors else "paper").lower()) or "paper"
    key = f"{key_author}{meta.get('year', '')}"
    fields: dict[str, str] = {
        "title": meta.get("title", ""),
        "author": " and ".join(authors),
    }
    venue = meta.get("venue", "")
    entry = "article"
    if meta.get("arxiv_id") and (not venue or venue.lower().startswith("arxiv")):
        fields["journal"] = f"arXiv preprint arXiv:{meta['arxiv_id']}"
        fields["eprint"] = meta["arxiv_id"]
        fields["archivePrefix"] = "arXiv"
    elif meta.get("kind") == "book" or (meta.get("publisher") and not venue):
        entry = "book"
        fields["publisher"] = meta.get("publisher", "")
        fields["isbn"] = meta.get("isbn", "")
    elif venue:
        fields["journal"] = venue
        fields["volume"] = meta.get("volume", "")
        fields["pages"] = meta.get("pages", "")
    fields["year"] = meta.get("year", "")
    fields["doi"] = meta.get("doi", "")
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields.items() if v)
    return f"@{entry}{{{key},\n{body}\n}}"


def _make_ppt_cite(rt: dict, meta: dict | None, bibtex: str, prompt: str = "", model: str = "") -> str:
    """The minimal slide-deck citation, one AI call over the BibTeX (else the
    meta JSON). Shared by the metadata fetch (generated alongside the record)
    and POST /metadata/cite (regenerate)."""
    system = (prompt or CITE_PROMPT).strip()[:4000]
    source = bibtex or json.dumps(meta, indent=2)
    entry = _resolve_model(rt, model)
    return _call_ai([{"role": "user", "content": source}], system, entry, rt,
                    max_tokens=4000, timeout=120,
                    on_usage=ai_usage.recorder("cite", entry, rt)).strip()


def _load_page(ws: str, block_id: str):
    with connect_pages_db(ws) as conn:
        row = conn.execute(
            "SELECT content, properties FROM unified_blocks WHERE id = ?", (block_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="page not found")
    return row[0] or "", json.loads(row[1] or "{}")


def _save_props(ws: str, block_id: str, updates: dict | None = None, remove: tuple = (),
                auto_title: str = "", actor: str = "") -> tuple[bool, str]:
    """Apply a delta to the page's properties, re-reading them inside the write.

    Lookups take seconds to minutes, and the user can label the page (which
    merges into properties via PUT /api/blocks/{id}) at any point during one.
    Writing back the dict we read before the lookup would silently drop that
    label, so only the keys metadata owns are touched here.

    Returns ``(renamed, title)``: whether THIS write replaced the automatic
    title, and the page's title as it stands after the write — which may
    already be the paper's, renamed by a concurrent lookup (the extension's
    background lookup races the one the app starts when the page opens)."""
    with connect_pages_db(ws) as conn:
        # Serialize the read/merge/write. Whichever wins the lock first is
        # safe: a later explicit rename wins after this commit, while a rename
        # that committed first is observed with auto_title already cleared.
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT content, properties FROM unified_blocks WHERE id = ?", (block_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="page not found")
        content = row[0] or ""
        props = json.loads(row[1] or "{}")
        props.update(updates or {})
        for key in remove:
            props.pop(key, None)
        # Rename only while the current title still matches the server-side
        # automatic-title marker (an explicit PUT title edit clears auto_title
        # in blocks.py; pages from before the marker existed were given one by
        # gamma/normalize.py).
        rename = bool(auto_title and props.get("auto_title")
                      and props.get("auto_title") == content)
        if rename:
            props.pop("auto_title", None)
        op = {"op": "set", "id": block_id,
              "props": props_patch(json.loads(row[1] or "{}"), props)}
        if rename:
            op["content"] = auto_title
        # client "meta": the batch is the metadata worker's, not a person's
        # keystrokes — an activity view or a sync can tell them apart.
        after_commit(ws, conn, apply_ops(conn, block_id, [op], actor=actor, client="meta"))
        return rename, (auto_title if rename else content)


@router.get("/metadata/status")
def metadata_status(request: Request):
    """Library-wide health for the Settings "Paper metadata" pane: which pages
    have metadata, which yielded extractable text, and whether the search index
    covers them. Listed: every page with a PDF attachment, plus pages that carry
    ``properties.meta`` without one (a note about a paper whose PDF you don't
    own — it still cites; ``has_file`` is false, index fields stay unknown).
    Text/index state comes from the FTS index (data.db) — pages=0 rows are
    recorded extraction failures, ver != INDEX_VERSION means stale; papers the
    index never saw report text_chars = null (unknown until indexed)."""
    ws = require_ws(request)
    with connect_pages_db(ws) as conn:
        rows = conn.execute(
            "SELECT id, content, properties, updated_at FROM unified_blocks WHERE parent_id = 'root'"
        ).fetchall()
    index = {}
    try:
        with sqlite3.connect(ws_db_path(ws, "data.db")) as conn:
            for doc_id, ver, pages, chars in conn.execute(
                "SELECT d.doc_id, d.ver, d.pages,"
                " (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM pdf_fts f WHERE f.doc_id = d.doc_id)"
                " FROM pdf_fts_docs d"
            ):
                index[doc_id] = {"ver": ver, "pages": pages or 0, "chars": chars or 0}
    except sqlite3.OperationalError:
        pass  # index tables don't exist yet — search has never run
    uploads = ws_uploads_dir(ws)
    papers = []
    for block_id, content, props_json, updated_at in rows:
        props = json.loads(props_json or "{}")
        attachment = page_attachment(props)
        if not attachment and not props.get("meta"):
            continue  # a plain note page: nothing to fetch metadata or text for
        doc_id = attachment["id"] if attachment else ""
        entry = index.get(doc_id)
        meta = props.get("meta") or None
        papers.append({
            "id": block_id,
            "title": (meta or {}).get("title") or content or "Untitled",
            "updated_at": updated_at,
            "doc_id": doc_id,
            "has_file": bool(doc_id and _DOC_ID_OK.match(doc_id)
                             and (uploads / f"{doc_id}.pdf").exists()),
            "has_meta": bool(meta),
            "meta_source": (meta or {}).get("source", ""),
            "meta_kind": (meta or {}).get("kind", ""),
            # None for records stored before the flag existed — the client
            # falls back to the source/kind rule (isUnverifiedPaperMeta).
            "meta_unverified": (meta or {}).get("unverified"),
            "meta_error": (props.get("meta_error") or {}).get("detail", ""),
            "indexed": bool(entry and entry["ver"] == INDEX_VERSION),
            "index_stale": bool(entry and entry["ver"] != INDEX_VERSION),
            "text_chars": entry["chars"] if entry else None,
        })
    return {"papers": papers}


class MetaFetchRequest(BaseModel):
    block_id: str
    prompt: str = ""   # custom AI metadata-extraction prompt (empty = built-in)
    model: str = ""
    force: bool = False
    context_char_limit: int = Field(default=6000, ge=100, le=1_000_000)
    cite_prompt: str = ""  # custom PPT-citation prompt for the citation generated alongside
    cite_model: str = ""


# Sync endpoints: external lookups + PyPDF2 text extraction run in the threadpool.
@router.post("/metadata/fetch")
def metadata_fetch(payload: MetaFetchRequest, request: Request):
    ws = require_ws(request, write=True)
    return fetch_page_metadata(ws, payload.block_id, request.state.user, prompt=payload.prompt, model=payload.model,
                               force=payload.force, context_char_limit=payload.context_char_limit,
                               cite_prompt=payload.cite_prompt, cite_model=payload.cite_model)


def fetch_page_metadata(ws: str, block_id: str, actor: str, prompt: str = "", model: str = "",
                        force: bool = False, context_char_limit: int = 6000,
                        doi: str = "", arxiv_id: str = "",
                        cite_prompt: str = "", cite_model: str = "") -> dict:
    """The lookup behind POST /api/metadata/fetch, callable off-request (the
    extension's /api/clip runs it in a background thread). ``actor`` is the
    account on whose behalf it runs — its AI providers do the AI part, its
    name goes on the op. doi/arxiv_id are
    caller-supplied hints — the extension's detector reads them off the
    publisher page's own meta tags, so they are trusted like URL-derived ids.
    A successful lookup also generates the slide citation (when AI is
    configured) so it is ready the moment the metadata is — not the first
    time someone opens the share popover. Raises HTTPException(404) when
    nothing was found (after negative-caching it)."""
    content, props = _load_page(ws, block_id)
    if props.get("meta") and not force:
        return {"meta": props["meta"], "bibtex": props.get("bibtex", ""),
                "ppt_cite": props.get("ppt_cite", ""),
                "source": props["meta"].get("source", ""), "cached": True,
                "title_updated": False, "page_title": content}

    doc_id = props.get("doc_id") or ""
    source_url = props.get("source_url") or ""
    # Identifier sources trusted without a title check: the stored source URL,
    # the web page the extension clipped from, and the detector hints.
    hints = "\n".join(filter(None, [
        source_url, str(props.get("web_url") or ""), doi, arxiv_id]))
    # Raw head text (no excerpt label — this text feeds regexes and matching).
    # The scan window is decoupled from the AI-context pref (see SCAN_CHARS);
    # the AI later gets only the pref-sized head slice.
    text, tail = "", ""
    if doc_id:
        text, next_offset, _ = _pdf_excerpt(ws, doc_id, max(context_char_limit, SCAN_CHARS))
        if text == PDF_EXTRACT_FAILED:  # nothing to read or match against
            text, next_offset = "", None
        if next_offset is not None:
            # The document continues past the scan window. The paper's own DOI
            # is often printed only in the end-of-article trailer (Science
            # issue-clipped PDFs), so scan the last page too.
            path = _pdf_path(ws, doc_id)
            npages = _page_count(str(path)) if path else 0
            if npages > 1:
                tail = _pdf_excerpt(ws, doc_id, 4000, start_page=npages)[0]
                if tail == PDF_EXTRACT_FAILED:
                    tail = ""
        # The paper is being set up — index it now (background) so search,
        # the AI document map and the library-wide Ctrl+F don't wait for the
        # first search to discover it. After our own head extraction: pdfium
        # is serialized behind one lock and the lookup needs its text now.
        _ensure_indexed(ws, doc_id)

    meta, bibtex = None, ""
    # "confirmed" = the record demonstrably describes THIS paper: its id came
    # from the source URL, or the registry's title appears in the PDF text.
    # Unconfirmed records are kept only until something confirmed shows up.
    confirmed = False

    trusted_arxiv = (arxiv_id or "").strip() or _find_arxiv_id(hints, "")
    aid = trusted_arxiv or _find_arxiv_id("", text)
    if aid:
        meta = _fetch_arxiv(aid)
        confirmed = bool(meta) and (bool(trusted_arxiv) or _title_in_text(meta["title"], text))

    if not confirmed:
        # The first DOI in the text can belong to a *cited* paper (footnotes
        # on page 1, a previous article's trailer in an issue-clipped PDF), so
        # resolve candidates until one's registrar title appears in the text;
        # an unconfirmed resolution is only a fallback. The tail rides along
        # so an own-DOI printed only in the end trailer is a candidate too.
        fallback = None
        for cand_doi in _find_doi_candidates(hints, text + "\n" + tail):
            m, b = _fetch_doi(cand_doi)
            if not m:
                continue
            if cand_doi.lower() in hints.lower() or _title_in_text(m["title"], text):
                meta, bibtex, confirmed = m, b, True
                break
            fallback = fallback or (m, b)
        if not confirmed and not meta and fallback:
            meta, bibtex = fallback

    if not confirmed:
        # Books: an ISBN printed in the PDF (copyright page, back cover) is
        # the book's own far more often than a page-1 DOI is the paper's, but
        # it is still confirmed only by the title (+ an author surname, book
        # titles being short) in the text; otherwise it's a fallback like an
        # unconfirmed DOI.
        fallback = None
        for isbn in _find_isbns(text + "\n" + tail):
            m = _fetch_isbn(isbn)
            if not m:
                continue
            if _record_in_text(m, text):
                meta, bibtex, confirmed = m, "", True
                break
            fallback = fallback or m
        if not confirmed and not meta and fallback:
            meta, bibtex = fallback, ""

    if not confirmed:
        # No trustworthy identifier — Crossref bibliographic search, accepted
        # only when the hit's exact title appears in the PDF. Deterministic,
        # and it keeps most publisher PDFs off the AI fallback. Queried with
        # the page title first (users often title pages with the paper name;
        # uploads may auto-carry a title-like filename), then the text head.
        queries = []
        page_title = re.sub(r"\.pdf$", "", (content or "").strip(), flags=re.I)
        if text and len(page_title.split()) >= 3:
            queries.append(page_title[:300])
        if text:
            queries.append(_norm_match(text[:1500])[:500])
        for q in queries:
            cand = _pick_crossref_match(_crossref_search(q), text)
            if cand:
                better, bib = _fetch_doi(cand["doi"])
                meta, bibtex, confirmed = (better or cand), bib, True
                break

    rt = ai_runtime(actor)
    if not meta and rt["enabled"] and text:
        meta = _ai_extract_meta(text[:context_char_limit], prompt, model, rt)
        if meta:
            # Upgrade to a registry record where possible; drop identifiers
            # that resolve nowhere and aren't in the PDF (fabrications).
            meta, bibtex = _verify_ai_meta(meta, text + "\n" + tail, hints)
            confirmed = meta.get("source") != "ai"
    if not meta:
        # Negative cache: remember the failed attempt on the page so clients
        # stop auto-retrying on every open. Manual ↻ (force) still retries,
        # and a success below clears the marker.
        _save_props(ws, block_id, {
            "meta_error": {"at": page_now(), "detail": "no arXiv id, DOI, Crossref, or AI match"}},
            actor=actor)
        raise HTTPException(status_code=404, detail="no metadata found (no arXiv id, DOI, Crossref, or AI match)")

    if not bibtex:
        bibtex = _build_bibtex(meta)
    # Stored with the record so every surface can warn before it is cited:
    # nothing tied the record to THIS document (an unconfirmed DOI/ISBN may
    # belong to a cited work; AI output may be a plausible hallucination).
    # AI-read non-papers (notes, slides…) have no registry to verify against,
    # so they are not flagged — there's nothing a warning could ask for.
    meta["unverified"] = (not confirmed
                          and not (meta.get("source") == "ai" and (meta.get("kind") or "paper") != "paper"))
    # The slide citation rides along: one AI call now, instead of on first
    # share. A failure here never fails the fetch — /metadata/cite retries.
    ppt_cite = ""
    if rt["enabled"]:
        try:
            ppt_cite = _make_ppt_cite(rt, meta, bibtex, cite_prompt, cite_model)
        except Exception as e:
            log.warning(f"[metadata] slide citation failed: {e}")
    title = str(meta.get("title") or "").strip()
    updates = {"meta": meta, "bibtex": bibtex}
    if ppt_cite:
        updates["ppt_cite"] = ppt_cite
    title_updated, page_title = _save_props(
        ws, block_id, updates,
        # a stale citation (generated from the previous record) is dropped
        remove=("meta_error",) + (() if ppt_cite else ("ppt_cite",)), auto_title=title, actor=actor,
    )
    # page_title is ALWAYS the page's current title, not only when this call
    # renamed it: a concurrent lookup may have done the rename first, and the
    # client shows whatever comes back here.
    return {"meta": meta, "bibtex": bibtex, "ppt_cite": ppt_cite, "source": meta.get("source", ""),
            "cached": False, "title_updated": title_updated, "page_title": page_title}


class MetaUpdateRequest(BaseModel):
    block_id: str
    meta: dict = {}


@router.post("/metadata/update")
def metadata_update(payload: MetaUpdateRequest, request: Request):
    """Save hand-edited metadata. BibTeX is rebuilt from the edited fields and
    the cached slide citation is invalidated. All-blank fields clear the
    cached metadata entirely."""
    ws = require_ws(request, write=True)
    _, props = _load_page(ws, payload.block_id)  # 404 before validating the edit
    m = payload.meta or {}
    authors = m.get("authors") or []
    if isinstance(authors, str):
        authors = [a.strip() for a in re.split(r",| and ", authors) if a.strip()]
    meta = {
        "title": str(m.get("title") or "").strip()[:500],
        "authors": [str(a).strip()[:200] for a in authors if str(a).strip()],
        "year": str(m.get("year") or "").strip()[:20],
        "venue": str(m.get("venue") or "").strip()[:300],
        "volume": str(m.get("volume") or "").strip()[:40],
        "pages": str(m.get("pages") or "").strip()[:60],
        "doi": str(m.get("doi") or "").strip()[:200],
        "arxiv_id": str(m.get("arxiv_id") or "").strip()[:60],
        "publisher": str(m.get("publisher") or "").strip()[:300],
        "isbn": re.sub(r"[^0-9Xx]", "", str(m.get("isbn") or ""))[:13].upper(),
        "source": "manual",
    }
    # The document kind survives a hand edit (a book stays @book); a hand
    # edit is the user vouching for the record, so it is not "unverified".
    kind = (props.get("meta") or {}).get("kind")
    if kind in _DOC_KINDS:
        meta["kind"] = kind
    # ppt_cite is stale (the metadata changed); meta_error is settled (or
    # reset) by the hand-edit either way
    stale = ("ppt_cite", "meta_error")
    if not any(v for k, v in meta.items() if k != "source"):
        _save_props(ws, payload.block_id, remove=stale + ("meta", "bibtex"), actor=request.state.user)
        return {"meta": None, "bibtex": "", "source": "", "cached": False}
    bibtex = _build_bibtex(meta)
    _save_props(ws, payload.block_id, {"meta": meta, "bibtex": bibtex}, remove=stale, actor=request.state.user)
    return {"meta": meta, "bibtex": bibtex, "source": "manual", "cached": False}


class CiteRequest(BaseModel):
    block_id: str
    prompt: str = ""   # custom PPT-citation prompt (empty = built-in)
    model: str = ""
    force: bool = False  # regenerate even when a cached citation exists


@router.post("/metadata/cite")
def metadata_cite(payload: CiteRequest, request: Request):
    ws = require_ws(request, write=True)
    _, props = _load_page(ws, payload.block_id)
    if props.get("ppt_cite") and not payload.force:
        return {"citation": props["ppt_cite"], "cached": True}
    rt = require_ai_runtime(request.state.user)
    meta = props.get("meta")
    bibtex = props.get("bibtex", "")
    if not meta and not bibtex:
        raise HTTPException(status_code=409, detail="no metadata yet — fetch metadata first")
    try:
        citation = _make_ppt_cite(rt, meta, bibtex, payload.prompt, payload.model)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI call failed: {e}")
    # cache alongside the rest of the metadata
    _save_props(ws, payload.block_id, {"ppt_cite": citation}, actor=request.state.user)
    return {"citation": citation, "cached": False}
