"""The /api/pdf proxy: streams upstream bytes through (with Content-Length so
clients can show progress), saves a local copy only on a complete download,
and rejects non-PDF upstreams. Upstream fetches are faked — no network."""

import hashlib
import io

import gamma.routers.pdf as pdf_mod
from gamma.db import user_uploads_dir

PDF_BYTES = b"%PDF-1.4 fake pdf body\n" + b"x" * 200_000


class FakeUpstream:
    """Duck-types the urlopen response the proxy consumes."""

    def __init__(self, url, data=PDF_BYTES, ctype="application/pdf", with_length=True):
        self._url = url
        self._buf = io.BytesIO(data)
        self.headers = {"Content-Type": ctype}
        if with_length:
            self.headers["Content-Length"] = str(len(data))
        self.closed = False

    def read(self, n=-1):
        return self._buf.read(n)

    def geturl(self):
        return self._url

    def close(self):
        self.closed = True

    # resolve-pdf consumes urlopen as a context manager
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def _fake(monkeypatch, **kwargs):
    made = []

    def fake_urlopen(req, timeout=30):
        up = FakeUpstream(req.full_url, **kwargs)
        made.append(up)
        return up

    # Patch the SSRF-guarded fetch wholesale so tests don't hit the network or
    # the URL validator (which would try to resolve the fake host).
    monkeypatch.setattr(pdf_mod, "guarded_urlopen", fake_urlopen)
    return made


def test_proxy_streams_pdf_with_length(guest, monkeypatch):
    made = _fake(monkeypatch)
    r = guest.get("/api/pdf", params={"source_url": "https://example.org/stream-test.pdf"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.headers.get("content-length") == str(len(PDF_BYTES))
    assert r.content == PDF_BYTES
    assert made and made[0].closed


def test_proxy_save_writes_complete_file_then_redirects(guest, monkeypatch):
    _fake(monkeypatch)
    url = "https://example.org/save-test.pdf"
    doc_id = hashlib.sha256(url.encode()).hexdigest()[:24]
    r = guest.get("/api/pdf", params={"source_url": url, "save": "1"})
    assert r.status_code == 200
    assert r.content == PDF_BYTES
    saved = user_uploads_dir("guest") / f"{doc_id}.pdf"
    assert saved.read_bytes() == PDF_BYTES
    # Second request must not hit upstream at all: it redirects to the saved copy.
    monkeypatch.setattr(pdf_mod, "guarded_urlopen", None)
    r2 = guest.get("/api/pdf", params={"source_url": url}, follow_redirects=False)
    assert r2.status_code == 302
    assert r2.headers["location"] == f"/api/uploads/{doc_id}.pdf"
    # Saved copies are immutable (hash-named) — served with a month-long cache.
    r3 = guest.get(f"/api/uploads/{doc_id}.pdf")
    assert r3.status_code == 200
    assert r3.headers["cache-control"] == "public, max-age=2592000, immutable"


def test_pdf_text_status_missing_doc(guest):
    r = guest.get("/api/pdf-text-status", params={"doc_id": "deadbeefdeadbeefdeadbeef"})
    assert r.status_code == 200
    assert r.json() == {"found": False, "ok": False, "chars": 0, "indexed": False, "index_stale": False}


def _text_pdf(text="Attention is all you need, and this line is long enough to count."):
    """Minimal hand-built one-page PDF with a real text layer."""
    stream = b"BT /F1 12 Tf 72 720 Td (" + text.encode() + b") Tj ET"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
        b" /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n%s\nendobj\n" % (i, obj))
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref))
    return out.getvalue()


def test_pdf_text_status_extracts_text(guest):
    """Regression: extract_text wasn't imported in ai.py, so every PDF —
    text layer or not — reported ok=False ("scanned or image-only")."""
    up = guest.post("/api/uploads", files={"file": ("t.pdf", _text_pdf(), "application/pdf")})
    assert up.status_code == 200, up.text
    doc_id = up.json()["doc_id"]
    r = guest.get("/api/pdf-text-status", params={"doc_id": doc_id})
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is True
    assert body["ok"] is True, body
    assert body["chars"] >= 50
    # preview returns the text itself
    r2 = guest.get("/api/pdf-text-status", params={"doc_id": doc_id, "preview": 200})
    assert "Attention is all you need" in r2.json()["text"]


def test_identifier_to_url():
    """Bare arXiv ids and DOIs pasted into the open-by-URL box become URLs;
    anything already URL-shaped passes through untouched."""
    f = pdf_mod._identifier_to_url
    assert f("2301.12345") == "https://arxiv.org/pdf/2301.12345"
    assert f("arXiv:2301.12345v2") == "https://arxiv.org/pdf/2301.12345v2"
    assert f("hep-th/9901001") == "https://arxiv.org/pdf/hep-th/9901001"
    assert f("math.GT/0309136") == "https://arxiv.org/pdf/math.GT/0309136"
    assert f("10.1103/PhysRevLett.130.123601") == "https://doi.org/10.1103/PhysRevLett.130.123601"
    assert f("doi:10.1038/s41586-023-06096-3") == "https://doi.org/10.1038/s41586-023-06096-3"
    # untouched: real URLs, page titles, random text
    assert f("https://example.org/a.pdf") == "https://example.org/a.pdf"
    assert f("attention is all you need") == "attention is all you need"


def test_resolve_pdf_accepts_bare_arxiv_id(guest, monkeypatch):
    _fake(monkeypatch)
    r = guest.post("/api/resolve-pdf", json={"source_url": "arXiv:2301.12345"})
    assert r.status_code == 200, r.text
    assert r.json()["source_url"] == "https://arxiv.org/pdf/2301.12345"


def test_resolve_pdf_bare_arxiv_doi_goes_to_arxiv(guest, monkeypatch):
    """A pasted arXiv DOI (10.48550/arXiv.…) short-circuits to arxiv.org."""
    _fake(monkeypatch)
    r = guest.post("/api/resolve-pdf", json={"source_url": "10.48550/arXiv.2301.12345"})
    assert r.status_code == 200, r.text
    assert r.json()["source_url"] == "https://arxiv.org/pdf/2301.12345"


def test_proxy_rejects_non_pdf(guest, monkeypatch):
    made = _fake(monkeypatch, data=b"<html>paywall</html>", ctype="text/html")
    r = guest.get("/api/pdf", params={"source_url": "https://example.org/not-a-pdf"})
    assert r.status_code == 400
    assert "not a PDF" in r.json()["detail"]
    assert made and made[0].closed
