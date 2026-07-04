"""Paper metadata + citations.

Lookup order: arXiv API (id from the source URL or the PDF text) → DOI via
doi.org content negotiation (Crossref/DataCite) → AI extraction from the first
pages as a fallback. There is deliberately no Google Scholar call — Scholar has
no official API and scraping it violates its ToS. Results are cached on the
page block (properties.meta / properties.bibtex).
"""

import json
import re
import sqlite3
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import require_user
from ..config import AI_ENABLED
from ..db import page_now, user_db_path
from .ai import METADATA_PROMPT, CITE_PROMPT, _call_ai, _extract_pdf_context, _resolve_model

router = APIRouter(prefix="/api", tags=["metadata"])

_ARXIV_URL_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})", re.I)
_ARXIV_TEXT_RE = re.compile(r"arXiv:\s*([0-9]{4}\.[0-9]{4,5})", re.I)
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
    m = _ARXIV_URL_RE.search(source_url or "") or _ARXIV_TEXT_RE.search((text or "")[:4000])
    return m.group(1) if m else ""


def _find_doi_candidates(source_url: str, text: str) -> list[str]:
    """DOI candidates, most likely first. PDF text extraction often glues the
    following word straight onto the DOI ("…-0478-8Physics Department"), so a
    trailing all-letters run after a digit yields a second, trimmed candidate."""
    m = _DOI_RE.search(source_url or "") or _DOI_RE.search((text or "")[:4000])
    if not m:
        return []
    doi = m.group(1).rstrip(".,;)]}’”")
    cands = [doi]
    glued = re.match(r"^(.*\d)([A-Za-z]{3,})$", doi)
    if glued and glued.group(1) not in cands:
        cands.append(glued.group(1))
    return cands


def _fetch_arxiv(arxiv_id: str) -> dict | None:
    try:
        raw = _http_get(f"https://export.arxiv.org/api/query?id_list={urllib.parse.quote(arxiv_id)}")
        entry = ET.fromstring(raw).find(f"{_ATOM}entry")
        if entry is None:
            return None
        title = re.sub(r"\s+", " ", entry.findtext(f"{_ATOM}title") or "").strip()
        if not title or title.lower() == "error":
            return None
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
    except Exception as e:
        print(f"[metadata] arxiv lookup failed: {e}")
        return None


def _fetch_doi(doi: str) -> tuple[dict | None, str]:
    """Metadata via doi.org content negotiation (works for Crossref and DataCite),
    plus the registrar's own BibTeX rendering."""
    url = f"https://doi.org/{urllib.parse.quote(doi)}"
    try:
        data = json.loads(_http_get(url, accept="application/vnd.citationstyles.csl+json"))
    except Exception as e:
        print(f"[metadata] doi lookup failed: {e}")
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
    bibtex = ""
    try:
        bibtex = _http_get(url, accept="application/x-bibtex").decode("utf-8", "replace").strip()
    except Exception:
        pass
    return meta, bibtex


def _ai_extract_meta(text: str, prompt: str, model: str) -> dict | None:
    system = (prompt or METADATA_PROMPT).strip()[:4000]
    try:
        raw = _call_ai(
            [{"role": "user", "content": f"First pages of the paper:\n\n{text[:6000]}"}],
            # Generous cap: reasoning models spend invisible tokens before the JSON
            system, _resolve_model(model), max_tokens=8000, timeout=120,
        )
        m = re.search(r"\{[\s\S]*\}", raw)
        if not m:
            return None
        data = json.loads(m.group(0))
    except Exception as e:
        print(f"[metadata] AI extraction failed: {e}")
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
        row = conn.execute(
            "SELECT content, properties FROM unified_blocks WHERE id = ?", (block_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="page not found")
    return row[0] or "", json.loads(row[1] or "{}")


def _save_props(user: str, block_id: str, props: dict):
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        conn.execute(
            "UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?",
            (json.dumps(props), page_now(), block_id),
        )
        conn.commit()


class MetaFetchRequest(BaseModel):
    block_id: str
    prompt: str = ""   # custom AI metadata-extraction prompt (empty = built-in)
    model: str = ""
    force: bool = False


# Sync endpoints: external lookups + PyPDF2 text extraction run in the threadpool.
@router.post("/metadata/fetch")
def metadata_fetch(payload: MetaFetchRequest, request: Request):
    user = require_user(request)
    _, props = _load_page(user, payload.block_id)
    if props.get("meta") and not payload.force:
        return {"meta": props["meta"], "bibtex": props.get("bibtex", ""),
                "source": props["meta"].get("source", ""), "cached": True}

    doc_id = props.get("doc_id") or ""
    source_url = props.get("source_url") or props.get("sourceUrl") or ""
    text = _extract_pdf_context(user, doc_id, limit=6000) if doc_id else ""

    meta, bibtex = None, ""
    arxiv_id = _find_arxiv_id(source_url, text)
    if arxiv_id:
        meta = _fetch_arxiv(arxiv_id)
    if not meta:
        for doi in _find_doi_candidates(source_url, text):
            meta, bibtex = _fetch_doi(doi)
            if meta:
                break
    if not meta and AI_ENABLED and text:
        meta = _ai_extract_meta(text, payload.prompt, payload.model)
        # If the AI surfaced an identifier, prefer the authoritative record
        if meta and meta.get("arxiv_id"):
            meta = _fetch_arxiv(meta["arxiv_id"]) or meta
        elif meta and meta.get("doi"):
            better, bib = _fetch_doi(meta["doi"])
            if better:
                meta, bibtex = better, bib
    if not meta:
        raise HTTPException(status_code=404, detail="no metadata found (no arXiv id, DOI, or AI match)")

    if not bibtex:
        bibtex = _build_bibtex(meta)
    props["meta"] = meta
    props["bibtex"] = bibtex
    _save_props(user, payload.block_id, props)
    return {"meta": meta, "bibtex": bibtex, "source": meta.get("source", ""), "cached": False}


class CiteRequest(BaseModel):
    block_id: str
    prompt: str = ""   # custom PPT-citation prompt (empty = built-in)
    model: str = ""


@router.post("/metadata/cite")
def metadata_cite(payload: CiteRequest, request: Request):
    if not AI_ENABLED:
        raise HTTPException(status_code=503, detail="AI not configured (set a provider API key)")
    user = require_user(request)
    _, props = _load_page(user, payload.block_id)
    meta = props.get("meta")
    bibtex = props.get("bibtex", "")
    if not meta and not bibtex:
        raise HTTPException(status_code=409, detail="no metadata yet — fetch metadata first")
    system = (payload.prompt or CITE_PROMPT).strip()[:4000]
    source = bibtex or json.dumps(meta, indent=2)
    try:
        text = _call_ai([{"role": "user", "content": source}], system,
                        _resolve_model(payload.model), max_tokens=4000, timeout=120)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI call failed: {e}")
    return {"citation": text.strip()}
