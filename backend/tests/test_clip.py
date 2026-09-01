"""The browser extension's endpoints: /api/clip (the one-shot "save this
paper" ingest), /api/library/lookup + /folders (popup helpers), and
/api/clip/note (clipped selections). Upstream fetches are faked — no network,
and the metadata thread is stubbed out."""

import hashlib
import io
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

import gamma.routers.clip as clip_mod
import gamma.routers.pdf as pdf_mod
from gamma.db import user_db_path, user_uploads_dir

PDF_BYTES = b"%PDF-1.4 clip test\n" + b"y" * 10_000


class FakeUpstream:
    def __init__(self, url, data=PDF_BYTES, ctype="application/pdf"):
        self._url, self._buf = url, io.BytesIO(data)
        self.headers = {"Content-Type": ctype, "Content-Length": str(len(data))}
        self.closed = False

    def read(self, n=-1):
        return self._buf.read(n)

    def geturl(self):
        return self._url

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


@pytest.fixture
def upstream(monkeypatch):
    """Fake the SSRF-guarded fetch: PDF for *.pdf URLs, HTML otherwise."""
    calls = []

    def fake_urlopen(req, timeout=30):
        calls.append(req.full_url)
        if req.full_url.endswith(".pdf") or "arxiv.org/pdf/" in req.full_url:
            return FakeUpstream(req.full_url)
        return FakeUpstream(req.full_url, data=b"<html><body>nothing here</body></html>", ctype="text/html")

    monkeypatch.setattr(pdf_mod, "guarded_urlopen", fake_urlopen)
    return calls


@pytest.fixture
def meta_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(clip_mod, "_start_metadata",
                        lambda user, block_id, doi="", arxiv_id="": calls.append((user, block_id, doi, arxiv_id)))
    return calls


def _props(block_id):
    with sqlite3.connect(user_db_path("guest", "pages.db")) as conn:
        row = conn.execute("SELECT content, properties FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
    return row[0], json.loads(row[1])


def test_clip_url_creates_filed_page_and_stores_pdf(guest, upstream, meta_calls):
    url = "https://example.org/papers/clip-one.pdf"
    r = guest.post("/api/clip", json={
        "source_url": "https://example.org/papers/clip-one",
        "pdf_url": url, "title": "  Clip   One  ", "folder": "reading/2026",
        "labels": ["to-read"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    doc_id = hashlib.sha256(url.encode()).hexdigest()[:24]
    assert body["doc_id"] == doc_id and body["existed"] is False
    assert body["title"] == "Clip One"
    assert body["open_url"] == f"/?block={body['block_id']}"
    assert (user_uploads_dir("guest") / f"{doc_id}.pdf").read_bytes() == PDF_BYTES
    title, props = _props(body["block_id"])
    assert title == "Clip One" and props["auto_title"] == "Clip One"
    assert props["source_url"] == url
    assert props["web_url"] == "https://example.org/papers/clip-one"
    assert props["folder"] == "reading/2026" and props["category"] == "to-read"
    assert meta_calls == [("guest", body["block_id"], "", "")]


def test_clip_forwards_detected_identifiers_to_metadata(guest, upstream, meta_calls):
    r = guest.post("/api/clip", json={
        "source_url": "https://journal.example/article",
        "pdf_url": "https://journal.example/article-file.pdf",
        "doi": "10.1234/abc.def",
    })
    assert r.status_code == 200, r.text
    assert meta_calls[0][2] == "10.1234/abc.def"


def test_clip_dedups_by_doi_and_adds_folder(guest, upstream, meta_calls):
    url = "https://example.org/papers/dedup.pdf"
    r = guest.post("/api/clip", json={"pdf_url": url, "title": "Dedup", "folder": "a"})
    block_id = r.json()["block_id"]
    # Pretend metadata landed with a DOI, as the lookup thread would.
    with sqlite3.connect(user_db_path("guest", "pages.db")) as conn:
        _, props = _props(block_id)
        props["meta"] = {"doi": "10.1000/DeDup.1", "title": "Dedup"}
        conn.execute("UPDATE unified_blocks SET properties = ? WHERE id = ?", (json.dumps(props), block_id))
        conn.commit()
    fetched_before = len(upstream)
    r2 = guest.post("/api/clip", json={
        "source_url": "https://publisher.example/article/whatever",
        "doi": "10.1000/dedup.1", "folder": "b", "labels": ["dup"],
    })
    assert r2.status_code == 200, r2.text
    assert r2.json()["existed"] is True and r2.json()["block_id"] == block_id
    assert len(upstream) == fetched_before  # nothing re-fetched
    _, props = _props(block_id)
    assert props["folder"] == "a, b" and props["category"] == "dup"
    # Same page, refined into a subfolder: the ancestor tag is replaced.
    guest.post("/api/clip", json={"doi": "10.1000/dedup.1", "folder": "a/deeper"})
    _, props = _props(block_id)
    assert props["folder"] == "b, a/deeper"


def test_clip_dead_link_leaves_no_page(guest, upstream, meta_calls):
    url = "https://example.org/not-a-paper"
    r = guest.post("/api/clip", json={"source_url": url, "title": "Ghost"})
    assert r.status_code == 400
    assert "PDF" in r.json()["detail"]
    with sqlite3.connect(user_db_path("guest", "pages.db")) as conn:
        assert not conn.execute("SELECT 1 FROM unified_blocks WHERE content = 'Ghost'").fetchone()
    assert meta_calls == []


def test_clip_no_copy_probes_only(guest, upstream, meta_calls):
    url = "https://example.org/papers/nocopy.pdf"
    r = guest.post("/api/clip", json={"pdf_url": url, "title": "No copy", "save_copy": False})
    assert r.status_code == 200, r.text
    doc_id = r.json()["doc_id"]
    assert not (user_uploads_dir("guest") / f"{doc_id}.pdf").exists()
    _, props = _props(r.json()["block_id"])
    assert props["source_url"] == url  # the app proxies it on open


def test_clip_from_uploaded_bytes(guest, upstream, meta_calls):
    data = b"%PDF-1.4 uploaded by the extension\n" + b"z" * 500
    up = guest.post("/api/uploads", files={"file": ("paywalled.pdf", data, "application/pdf")})
    assert up.status_code == 200, up.text
    doc_id = up.json()["doc_id"]
    r = guest.post("/api/clip", json={
        "doc_id": doc_id, "source_url": "https://journal.example/doi/10.1000/paywalled",
        "title": "Paywalled paper", "folder": "inbox",
    })
    assert r.status_code == 200, r.text
    assert r.json()["doc_id"] == doc_id
    assert upstream == []  # no server-side fetch at all
    _, props = _props(r.json()["block_id"])
    assert props["source_url"] == f"/api/uploads/{doc_id}.pdf"
    assert props["web_url"] == "https://journal.example/doi/10.1000/paywalled"
    # Second save from the same publisher page is found via web_url / its DOI.
    lk = guest.get("/api/library/lookup", params={"url": "https://journal.example/doi/10.1000/paywalled"})
    assert lk.status_code == 200 and lk.json()["block_id"] == r.json()["block_id"]
    # Unknown / unsafe doc ids never create a page.
    assert guest.post("/api/clip", json={"doc_id": "deadbeefdeadbeefdeadbeef"}).status_code == 404
    assert guest.post("/api/clip", json={"doc_id": "../../etc"}).status_code == 400


def test_lookup_by_arxiv_and_doi(guest, upstream, meta_calls):
    r = guest.post("/api/clip", json={"source_url": "https://arxiv.org/abs/2601.01234v2", "title": "Arx"})
    assert r.status_code == 200, r.text
    block_id = r.json()["block_id"]
    _, props = _props(block_id)
    # Bare arXiv ids are version-stripped before resolving: the canonical PDF is the latest.
    assert props["source_url"] == "https://arxiv.org/pdf/2601.01234"
    for params in ({"arxiv_id": "2601.01234"}, {"url": "https://arxiv.org/pdf/2601.01234v1"},
                   {"url": "arXiv:2601.01234"}, {"url": "https://arxiv.org/abs/2601.01234v2"}):
        lk = guest.get("/api/library/lookup", params=params)
        assert lk.status_code == 200, (params, lk.text)
        assert lk.json()["block_id"] == block_id
    assert guest.get("/api/library/lookup", params={"doi": "10.9999/nope"}).status_code == 404
    assert guest.get("/api/library/lookup", params={"url": "https://example.org/unknown"}).status_code == 404
    assert guest.get("/api/library/lookup").status_code == 400


def test_folders_lists_ancestors_and_labels(guest, upstream, meta_calls):
    guest.post("/api/clip", json={"pdf_url": "https://example.org/papers/f1.pdf", "folder": "qc/readout/fast",
                                  "labels": ["Zeta label"]})
    r = guest.get("/api/library/folders")
    assert r.status_code == 200
    body = r.json()
    for f in ("qc", "qc/readout", "qc/readout/fast"):
        assert f in body["folders"]
    assert "Zeta label" in body["labels"]


def test_clip_note_creates_web_clips_page_and_appends(guest):
    r = guest.post("/api/clip/note", json={
        "text": "First line\n\nSecond line", "source_url": "https://blog.example/post", "title": "A post",
    })
    assert r.status_code == 200, r.text
    page_id = r.json()["page_id"]
    title, props = _props(page_id)
    assert title == "Web clips" and props.get("web_clips") == 1
    content, _ = _props(r.json()["block_id"])
    assert content == "> First line\n>\n> Second line\n— [A post](https://blog.example/post)"
    r2 = guest.post("/api/clip/note", json={"text": "Another", "source_url": "https://blog.example/2"})
    assert r2.json()["page_id"] == page_id  # reused, not recreated
    kids = guest.get(f"/api/blocks/{page_id}/children").json()
    ids = [b["id"] for b in (kids if isinstance(kids, list) else kids.get("children", kids.get("blocks", [])))]
    assert ids[-1] == r2.json()["block_id"]
    # Explicit target page; unknown page → 404; empty text → 400.
    r3 = guest.post("/api/clip/note", json={"text": "Into a paper", "page_id": page_id})
    assert r3.status_code == 200 and r3.json()["page_id"] == page_id
    assert guest.post("/api/clip/note", json={"text": "x", "page_id": "nope"}).status_code == 404
    assert guest.post("/api/clip/note", json={"text": "   "}).status_code == 400


def test_clip_endpoints_require_a_session():
    from gamma.app import app
    anon = TestClient(app)
    assert anon.post("/api/clip", json={"pdf_url": "https://example.org/x.pdf"}).status_code == 401
    assert anon.get("/api/library/lookup", params={"doi": "10.1/x"}).status_code == 401
    assert anon.get("/api/library/folders").status_code == 401
    assert anon.post("/api/clip/note", json={"text": "x"}).status_code == 401


# --- fork hardening -----------------------------------------------------------

def test_oversized_pdf_is_refused_before_it_is_buffered(guest, monkeypatch, meta_calls):
    """/api/clip buffers the whole PDF in memory (unlike the streaming proxy),
    so it must stop at the upload ceiling instead of reading whatever the
    upstream server sends. Enforced while reading, because Content-Length is
    the upstream's claim, not a fact."""
    from gamma.config import MAX_UPLOAD_BYTES

    read_total = {"n": 0}

    class Endless:
        headers = {"Content-Type": "application/pdf"}  # no Content-Length at all

        def read(self, n=-1):
            read_total["n"] += n
            return b"y" * n

        def geturl(self):
            return "https://example.com/huge.pdf"

        def close(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(pdf_mod, "guarded_urlopen", lambda req, timeout=30: Endless())
    r = guest.post("/api/clip", json={"pdf_url": "https://example.com/huge.pdf"})
    assert r.status_code == 413, r.json()
    assert "larger than" in r.json()["detail"]
    # Stopped promptly: a little over the cap, not unbounded.
    assert read_total["n"] <= MAX_UPLOAD_BYTES + 1024 * 1024
    # …and no page was created for it.
    with sqlite3.connect(user_db_path("guest", "pages.db")) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM unified_blocks WHERE content LIKE '%huge%'").fetchone()[0] == 0


def test_a_lying_content_length_does_not_get_a_free_pass(guest, monkeypatch, meta_calls):
    """An honest oversized Content-Length is rejected up front, without reading
    the body at all."""
    reads = {"n": 0}

    class Liar:
        headers = {"Content-Type": "application/pdf", "Content-Length": str(900 * 1024 * 1024)}

        def read(self, n=-1):
            reads["n"] += 1
            return b""

        def geturl(self):
            return "https://example.com/claims-big.pdf"

        def close(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(pdf_mod, "guarded_urlopen", lambda req, timeout=30: Liar())
    r = guest.post("/api/clip", json={"pdf_url": "https://example.com/claims-big.pdf"})
    assert r.status_code == 413, r.json()
    assert reads["n"] == 0, "the body should not be read once the header rules it out"


def test_saved_clip_is_queued_for_flattening(guest, upstream, meta_calls, monkeypatch):
    """A scanned paper saved through the extension needs the same background
    flattening an upload or a proxied save gets, or the viewer renders it at
    about a second a page."""
    queued = []
    monkeypatch.setattr(clip_mod.flatten_queue, "schedule",
                        lambda user, doc_id: queued.append((user, doc_id)))
    r = guest.post("/api/clip", json={"pdf_url": "https://example.com/scan.pdf"})
    assert r.status_code == 200, r.text
    assert queued == [("guest", r.json()["doc_id"])]


def test_not_saving_a_copy_does_not_queue_flattening(guest, upstream, meta_calls, monkeypatch):
    queued = []
    monkeypatch.setattr(clip_mod.flatten_queue, "schedule",
                        lambda user, doc_id: queued.append((user, doc_id)))
    r = guest.post("/api/clip", json={"pdf_url": "https://example.com/x.pdf", "save_copy": False})
    assert r.status_code == 200, r.text
    assert queued == []


def test_clip_doc_id_matches_the_proxy_cache_id(guest):
    """The dedup in find_page recomputes the proxy's content-addressed id for a
    URL. If the two ever used different digest lengths, every proxied paper
    would silently clip a second time."""
    url = "https://example.com/some/paper.pdf"
    assert clip_mod.url_doc_id(url) == hashlib.sha256(url.encode()).hexdigest()[:24]
    from gamma.storage import DIGEST_CHARS
    assert DIGEST_CHARS == 24


def test_clip_is_never_reachable_with_a_share_token(guest, upstream, meta_calls):
    """Clipping writes to the library, so it must require a real session — a
    share link is a read principal for one document."""
    from gamma.app import app

    anon = TestClient(app)
    share = "sharetoken123456"
    for path, kwargs in (
        ("/api/clip", {"json": {"pdf_url": "https://example.com/a.pdf"}}),
        ("/api/clip/note", {"json": {"text": "hi"}}),
    ):
        assert anon.post(f"{path}?share={share}", **kwargs).status_code == 401
    for path in ("/api/library/lookup?url=https://example.com/a.pdf", "/api/library/folders"):
        assert anon.get(f"{path}&share={share}" if "?" in path else f"{path}?share={share}").status_code == 401


def test_clip_note_caps_a_huge_selection(guest):
    r = guest.post("/api/clip/note", json={"text": "x" * 50_000, "source_url": "https://example.com/p"})
    assert r.status_code == 200, r.text
    with sqlite3.connect(user_db_path("guest", "pages.db")) as conn:
        content = conn.execute("SELECT content FROM unified_blocks WHERE id = ?",
                               (r.json()["block_id"],)).fetchone()[0]
    # 20 000 characters of selection, quoted, plus the source line.
    assert 20_000 < len(content) < 20_200


def test_clip_rejects_a_traversal_doc_id(guest, meta_calls):
    """doc_id names a file in the user's uploads dir — it must be validated,
    not concatenated."""
    for bad in ("../../etc/passwd", "..%2fsecret", "a/b", "x" * 200):
        r = guest.post("/api/clip", json={"doc_id": bad})
        assert r.status_code in (400, 404), (bad, r.status_code)
        if r.status_code == 400:
            assert "invalid doc_id" in r.json()["detail"]


def test_clip_records_its_identifiers_so_dedup_works_before_metadata(guest, upstream, meta_calls):
    """The metadata lookup runs off-request and can fail. Until it lands, the
    only record of what this paper IS would otherwise be its URL — so the same
    paper reached by DOI would be saved a second time, and the popup would keep
    offering to save it. /api/clip keeps the identifiers it was handed."""
    r = guest.post("/api/clip", json={
        "pdf_url": "https://example.org/papers/resnet.pdf",
        "doi": "10.1109/CVPR.2016.90",
        "arxiv_id": "1512.03385",
        "title": "Deep Residual Learning",
    })
    assert r.status_code == 200, r.text
    first = r.json()["block_id"]
    _, props = _props(first)
    assert props["clip_doi"] == "10.1109/cvpr.2016.90"
    assert props["clip_arxiv_id"] == "1512.03385"
    assert not props.get("meta"), "metadata is stubbed out here — dedup must not depend on it"

    # Same paper, reached by DOI only: no resolve, no second page.
    again = guest.post("/api/clip", json={"doi": "10.1109/CVPR.2016.90"})
    assert again.status_code == 200, again.text
    assert again.json()["block_id"] == first
    assert again.json()["existed"] is True

    # …and by arXiv id only, with a version suffix.
    by_arxiv = guest.post("/api/clip", json={"arxiv_id": "1512.03385v2"})
    assert by_arxiv.status_code == 200, by_arxiv.text
    assert by_arxiv.json()["block_id"] == first

    # The popup's badge uses the same matcher, so it lights up too.
    for params in ({"doi": "10.1109/CVPR.2016.90"}, {"arxiv_id": "1512.03385"}):
        got = guest.get("/api/library/lookup", params=params)
        assert got.status_code == 200, (params, got.text)
        assert got.json()["block_id"] == first


def test_clip_identifiers_do_not_masquerade_as_metadata(guest, upstream, meta_calls):
    """The recorded identifiers are "what the clipper was told", not a resolved
    citation: they must not populate properties.meta, or the metadata worker
    would consider the page already done."""
    r = guest.post("/api/clip", json={"pdf_url": "https://example.org/p/x.pdf",
                                      "doi": "10.5555/abc"})
    _, props = _props(r.json()["block_id"])
    assert "meta" not in props
    assert props["clip_doi"] == "10.5555/abc"
    # The lookup was still queued, so a real citation can replace it later.
    assert meta_calls and meta_calls[-1][1] == r.json()["block_id"]
