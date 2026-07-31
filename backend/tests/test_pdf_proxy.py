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


def _fake(monkeypatch, **kwargs):
    made = []

    def fake_urlopen(req, timeout=30):
        up = FakeUpstream(req.full_url, **kwargs)
        made.append(up)
        return up

    monkeypatch.setattr(pdf_mod, "urlopen", fake_urlopen)
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
    monkeypatch.setattr(pdf_mod, "urlopen", None)
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
    assert r.json() == {"found": False, "ok": False, "chars": 0}


def test_proxy_rejects_non_pdf(guest, monkeypatch):
    made = _fake(monkeypatch, data=b"<html>paywall</html>", ctype="text/html")
    r = guest.get("/api/pdf", params={"source_url": "https://example.org/not-a-pdf"})
    assert r.status_code == 400
    assert "not a PDF" in r.json()["detail"]
    assert made and made[0].closed
