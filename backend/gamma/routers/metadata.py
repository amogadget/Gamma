"""Paper metadata + citations.

Lookup order: arXiv API (id from the source URL or the PDF text) → DOI via
doi.org content negotiation (Crossref/DataCite) → Crossref bibliographic
search on the text head → AI extraction from the first pages as a last resort.
A registry record found via the *text* (not the source URL) is only trusted
outright when its title actually appears in the PDF — the first DOI on page 1
can belong to a cited paper, and AI output can be a plausible hallucination.
There is deliberately no Google Scholar call — Scholar has no official API and
scraping it violates its ToS. Results are cached on the page block
(properties.meta / properties.bibtex).
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

from ..ai_client import call_ai as _call_ai
from ..ai_context import ensure_indexed as _ensure_indexed
from ..ai_context import pdf_excerpt as _pdf_excerpt
from ..ai_context import pdf_path as _pdf_path
from ..ai_settings import ai_runtime, require_ai_runtime
from ..auth import require_user
from ..db import page_now, user_db_path, user_uploads_dir
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


def _fetch_arxiv(arxiv_id: str) -> dict | None:
    try:
        raw = _http_get(f"https://export.arxiv.org/api/query?id_list={urllib.parse.quote(arxiv_id)}")
        entry = ET.fromstring(raw).find(f"{_ATOM}entry")
        if entry is None:
            return None
        title = re.sub(r"\s+", " ", entry.findtext(f"{_ATOM}title") or "").strip()
        if not title or title.lower() == "error":
            return None
        authors = [(a.findtext(f"{_ATOM}name") or "").strip() for a in entry.findall(f"{_ATOM}author")]
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
    except Exception as e:
        log.warning(f"[metadata] arxiv lookup failed: {e}")
        return None


def _fetch_doi(doi: str) -> tuple[dict | None, str]:
    """Metadata via doi.org content negotiation (works for Crossref and DataCite),
    plus the registrar's own BibTeX rendering."""
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
            " ".join(filter(None, [a.get("given"), a.get("family")])).strip() for a in (data.get("author") or [])
        ],
        "year": str(date_parts[0] or ""),
        "venue": str(data.get("container-title") or ""),
        "volume": str(data.get("volume") or ""),
        "pages": str(data.get("page") or ""),
        "doi": doi,
        "arxiv_id": "",
        "source": "doi",
    }
    bibtex = ""
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


def _verify_ai_meta(meta: dict, text: str, source_url: str) -> tuple[dict, str]:
    """AI extraction is a last resort and hallucinates plausible records
    (blended author lists, wrong volumes, fabricated DOIs — the prompt's
    "never invent" is not enforcement). Upgrade to the authoritative registry
    record when an identifier the AI produced actually resolves; otherwise
    cross-check the AI title against a Crossref search. An identifier that
    resolves nowhere and doesn't occur in the PDF text is dropped rather than
    stored — a missing DOI is recoverable, a fabricated one poisons BibTeX."""
    hay = ((source_url or "") + "\n" + (text or "")[:SCAN_CHARS + 4000]).lower()
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
    return meta, ""


def _ai_extract_meta(text: str, prompt: str, model: str, rt: dict) -> dict | None:
    system = (prompt or METADATA_PROMPT).strip()[:4000]
    try:
        raw = _call_ai(
            [{"role": "user", "content": f"First pages of the paper:\n\n{text}"}],
            # Generous cap: reasoning models spend invisible tokens before the JSON
            system,
            _resolve_model(rt, model),
            rt,
            max_tokens=8000,
            timeout=120,
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
    return {
        "title": str(data.get("title") or "").strip(),
        "authors": [str(a).strip() for a in authors if str(a).strip()],
        "year": str(data.get("year") or "").strip(),
        "venue": str(data.get("venue") or "").strip(),
        "volume": str(data.get("volume") or "").strip(),
        "pages": str(data.get("pages") or "").strip(),
        "doi": str(data.get("doi") or "").strip(),
        "arxiv_id": str(data.get("arxiv_id") or "").strip(),
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
    if meta.get("arxiv_id") and (not venue or venue.lower().startswith("arxiv")):
        fields["journal"] = f"arXiv preprint arXiv:{meta['arxiv_id']}"
        fields["eprint"] = meta["arxiv_id"]
        fields["archivePrefix"] = "arXiv"
    elif venue:
        fields["journal"] = venue
        fields["volume"] = meta.get("volume", "")
        fields["pages"] = meta.get("pages", "")
    fields["year"] = meta.get("year", "")
    fields["doi"] = meta.get("doi", "")
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields.items() if v)
    return f"@article{{{key},\n{body}\n}}"


def _load_page(user: str, block_id: str):
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        row = conn.execute("SELECT content, properties FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="page not found")
    return row[0] or "", json.loads(row[1] or "{}")


def _save_props(user: str, block_id: str, updates: dict | None = None, remove: tuple = (),
                auto_title: str = "") -> bool:
    """Apply a delta to the page's properties, re-reading them inside the write.

    Lookups take seconds to minutes, and the user can label the page (which
    merges into properties via PUT /api/blocks/{id}) at any point during one.
    Writing back the dict we read before the lookup would silently drop that
    label, so only the keys metadata owns are touched here.

    `auto_title`, when given, renames the page — but only as a compare-and-swap
    against the automatic-title marker, so a rename the user made while the
    lookup was in flight always wins. Returns whether the rename happened."""
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
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
        # automatic-title marker. The legacy prefix keeps pages created before
        # this marker existed eligible; an explicit PUT title edit clears
        # auto_title in blocks.py.
        rename = bool(auto_title and (
            (props.get("auto_title") and props.get("auto_title") == content)
            or (not props.get("auto_title") and content.startswith("PDF Notes - "))
        ))
        if rename:
            props.pop("auto_title", None)
            conn.execute(
                "UPDATE unified_blocks SET content = ?, properties = ?, updated_at = ? WHERE id = ?",
                (auto_title, json.dumps(props), page_now(), block_id),
            )
        else:
            conn.execute(
                "UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?",
                (json.dumps(props), page_now(), block_id),
            )
        conn.commit()
        return rename


@router.get("/metadata/status")
def metadata_status(request: Request):
    """Library-wide health for the Settings "Paper metadata" pane: which papers
    have metadata, which yielded extractable text, and whether the search index
    covers them. Text/index state comes from the FTS index (data.db) — pages=0
    rows are recorded extraction failures, ver != INDEX_VERSION means stale;
    papers the index never saw report text_chars = null (unknown until indexed)."""
    user = require_user(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        rows = conn.execute(
            "SELECT id, content, properties, updated_at FROM unified_blocks WHERE parent_id = 'root'"
        ).fetchall()
    index = {}
    try:
        with sqlite3.connect(user_db_path(user, "data.db")) as conn:
            for doc_id, ver, pages, chars in conn.execute(
                "SELECT d.doc_id, d.ver, d.pages,"
                " (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM pdf_fts f WHERE f.doc_id = d.doc_id)"
                " FROM pdf_fts_docs d"
            ):
                index[doc_id] = {"ver": ver, "pages": pages or 0, "chars": chars or 0}
    except sqlite3.OperationalError:
        pass  # index tables don't exist yet — search has never run
    uploads = user_uploads_dir(user)
    papers = []
    for block_id, content, props_json, updated_at in rows:
        props = json.loads(props_json or "{}")
        doc_id = props.get("doc_id") or ""
        if not doc_id and not (props.get("source_url") or props.get("sourceUrl")):
            continue  # plain note page, not a paper
        entry = index.get(doc_id)
        meta = props.get("meta") or None
        papers.append(
            {
                "id": block_id,
                "title": (meta or {}).get("title") or content or "Untitled",
                "updated_at": updated_at,
                "doc_id": doc_id,
                "has_file": bool(doc_id and _DOC_ID_OK.match(doc_id)
                                 and (uploads / f"{doc_id}.pdf").exists()),
                "has_meta": bool(meta),
                "meta_source": (meta or {}).get("source", ""),
                "meta_error": (props.get("meta_error") or {}).get("detail", ""),
                "indexed": bool(entry and entry["ver"] == INDEX_VERSION),
                "index_stale": bool(entry and entry["ver"] != INDEX_VERSION),
                "text_chars": entry["chars"] if entry else None,
            }
        )
    return {"papers": papers}


class MetaFetchRequest(BaseModel):
    block_id: str
    prompt: str = ""  # custom AI metadata-extraction prompt (empty = built-in)
    model: str = ""
    force: bool = False
    context_char_limit: int = Field(default=6000, ge=100, le=1_000_000)


# Sync endpoints: external lookups + PyPDF2 text extraction run in the threadpool.
@router.post("/metadata/fetch")
def metadata_fetch(payload: MetaFetchRequest, request: Request):
    user = require_user(request)
    return fetch_page_metadata(user, payload.block_id, prompt=payload.prompt, model=payload.model,
                               force=payload.force, context_char_limit=payload.context_char_limit)


def fetch_page_metadata(user: str, block_id: str, prompt: str = "", model: str = "",
                        force: bool = False, context_char_limit: int = 6000) -> dict:
    """The lookup behind POST /api/metadata/fetch, callable off-request (the
    extension's /api/clip runs it in a background thread). Raises
    HTTPException(404) when nothing was found (after negative-caching it)."""
    content, props = _load_page(user, block_id)
    if props.get("meta") and not force:
        return {
            "meta": props["meta"],
            "bibtex": props.get("bibtex", ""),
            "source": props["meta"].get("source", ""),
            "cached": True,
        }

    doc_id = props.get("doc_id") or ""
    source_url = props.get("source_url") or props.get("sourceUrl") or ""
    # Raw head text (no excerpt label — this text feeds regexes and matching).
    # The scan window is decoupled from the AI-context pref (see SCAN_CHARS);
    # the AI later gets only the pref-sized head slice.
    text, tail = "", ""
    if doc_id:
        text, next_offset, _ = _pdf_excerpt(user, doc_id, max(context_char_limit, SCAN_CHARS))
        if text == PDF_EXTRACT_FAILED:  # nothing to read or match against
            text, next_offset = "", None
        if next_offset is not None:
            # The document continues past the scan window. The paper's own DOI
            # is often printed only in the end-of-article trailer (Science
            # issue-clipped PDFs), so scan the last page too.
            path = _pdf_path(user, doc_id)
            npages = _page_count(str(path)) if path else 0
            if npages > 1:
                tail = _pdf_excerpt(user, doc_id, 4000, start_page=npages)[0]
                if tail == PDF_EXTRACT_FAILED:
                    tail = ""
        # The paper is being set up — index it now (background) so search,
        # the AI document map and the library-wide Ctrl+F don't wait for the
        # first search to discover it. After our own head extraction: pdfium
        # is serialized behind one lock and the lookup needs its text now.
        _ensure_indexed(user, doc_id)

    meta, bibtex = None, ""
    # "confirmed" = the record demonstrably describes THIS paper: its id came
    # from the source URL, or the registry's title appears in the PDF text.
    # Unconfirmed records are kept only until something confirmed shows up.
    confirmed = False

    arxiv_url_id = _find_arxiv_id(source_url, "")
    arxiv_id = arxiv_url_id or _find_arxiv_id("", text)
    if arxiv_id:
        meta = _fetch_arxiv(arxiv_id)
        confirmed = bool(meta) and (bool(arxiv_url_id) or _title_in_text(meta["title"], text))

    if not confirmed:
        # The first DOI in the text can belong to a *cited* paper (footnotes
        # on page 1, a previous article's trailer in an issue-clipped PDF), so
        # resolve candidates until one's registrar title appears in the text;
        # an unconfirmed resolution is only a fallback. The tail rides along
        # so an own-DOI printed only in the end trailer is a candidate too.
        fallback = None
        for doi in _find_doi_candidates(source_url, text + "\n" + tail)[:8]:
            m, b = _fetch_doi(doi)
            if not m:
                continue
            if doi.lower() in (source_url or "").lower() or _title_in_text(m["title"], text):
                meta, bibtex, confirmed = m, b, True
                break
            fallback = fallback or (m, b)
        if not confirmed and not meta and fallback:
            meta, bibtex = fallback

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

    rt = ai_runtime(user)
    if not meta and rt["enabled"] and text:
        meta = _ai_extract_meta(text[:context_char_limit], prompt, model, rt)
        if meta:
            # Upgrade to a registry record where possible; drop identifiers
            # that resolve nowhere and aren't in the PDF (fabrications).
            meta, bibtex = _verify_ai_meta(meta, text + "\n" + tail, source_url)
    if not meta:
        # Negative cache: remember the failed attempt on the page so clients
        # stop auto-retrying on every open. Manual ↻ (force) still retries,
        # and a success below clears the marker.
        _save_props(user, block_id, {
            "meta_error": {"at": page_now(), "detail": "no arXiv id, DOI, Crossref, or AI match"}})
        raise HTTPException(status_code=404, detail="no metadata found (no arXiv id, DOI, Crossref, or AI match)")

    if not bibtex:
        bibtex = _build_bibtex(meta)
    # ppt_cite is dropped because the metadata it was generated from changed
    title = str(meta.get("title") or "").strip()
    title_updated = _save_props(
        user, block_id, {"meta": meta, "bibtex": bibtex},
        remove=("meta_error", "ppt_cite"), auto_title=title,
    )
    return {"meta": meta, "bibtex": bibtex, "source": meta.get("source", ""),
            "cached": False, "title_updated": title_updated,
            "page_title": title if title_updated else ""}


class MetaUpdateRequest(BaseModel):
    block_id: str
    meta: dict = {}


@router.post("/metadata/update")
def metadata_update(payload: MetaUpdateRequest, request: Request):
    """Save hand-edited metadata. BibTeX is rebuilt from the edited fields and
    the cached slide citation is invalidated. All-blank fields clear the
    cached metadata entirely."""
    user = require_user(request)
    _load_page(user, payload.block_id)  # 404 before validating the edit
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
        "source": "manual",
    }
    # ppt_cite is stale (the metadata changed); meta_error is settled (or
    # reset) by the hand-edit either way
    stale = ("ppt_cite", "meta_error")
    if not any(v for k, v in meta.items() if k != "source"):
        _save_props(user, payload.block_id, remove=stale + ("meta", "bibtex"))
        return {"meta": None, "bibtex": "", "source": "", "cached": False}
    bibtex = _build_bibtex(meta)
    _save_props(user, payload.block_id, {"meta": meta, "bibtex": bibtex}, remove=stale)
    return {"meta": meta, "bibtex": bibtex, "source": "manual", "cached": False}


class CiteRequest(BaseModel):
    block_id: str
    prompt: str = ""  # custom PPT-citation prompt (empty = built-in)
    model: str = ""
    force: bool = False  # regenerate even when a cached citation exists


@router.post("/metadata/cite")
def metadata_cite(payload: CiteRequest, request: Request):
    user = require_user(request)
    _, props = _load_page(user, payload.block_id)
    if props.get("ppt_cite") and not payload.force:
        return {"citation": props["ppt_cite"], "cached": True}
    rt = require_ai_runtime(user)
    meta = props.get("meta")
    bibtex = props.get("bibtex", "")
    if not meta and not bibtex:
        raise HTTPException(status_code=409, detail="no metadata yet — fetch metadata first")
    system = (payload.prompt or CITE_PROMPT).strip()[:4000]
    source = bibtex or json.dumps(meta, indent=2)
    try:
        text = _call_ai(
            [{"role": "user", "content": source}],
            system,
            _resolve_model(rt, payload.model),
            rt,
            max_tokens=4000,
            timeout=120,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI call failed: {e}")
    citation = text.strip()
    # cache alongside the rest of the metadata
    _save_props(user, payload.block_id, {"ppt_cite": citation})
    return {"citation": citation, "cached": False}
