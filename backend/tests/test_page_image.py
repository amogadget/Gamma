"""Server-rendered page previews: geometry, caching and the guards."""

import io

from PIL import Image


def _make_pdf(pages=3, w=612, h=792):
    import pikepdf
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(w, h))
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def test_renders_and_caches(guest):
    doc = guest.post("/api/uploads", files={"file": ("t.pdf", _make_pdf(), "application/pdf")}).json()
    doc_id = doc["doc_id"]

    r = guest.get(f"/api/page-image/{doc_id}/2?w=1280")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    # immutable: the doc id is a content hash and the width is from a fixed set,
    # so these bytes can never mean something else.
    assert "immutable" in r.headers.get("cache-control", "")

    img = Image.open(io.BytesIO(r.content))
    assert img.width == 1280
    # Aspect must match the page, or the preview would not line up with the
    # canvas it stands in for (both are stretched to the same box).
    assert abs(img.height / img.width - 792 / 612) < 0.01

    # Second call is served from disk — same bytes.
    assert guest.get(f"/api/page-image/{doc_id}/2?w=1280").content == r.content


def test_width_is_snapped_to_the_allowed_set(guest):
    doc_id = guest.post("/api/uploads", files={"file": ("t.pdf", _make_pdf(), "application/pdf")}).json()["doc_id"]
    img = Image.open(io.BytesIO(guest.get(f"/api/page-image/{doc_id}/1?w=9999").content))
    assert img.width == 1600   # nearest allowed, not 9999


def test_rejects_bad_input(guest):
    doc_id = guest.post("/api/uploads", files={"file": ("t.pdf", _make_pdf(2), "application/pdf")}).json()["doc_id"]
    assert guest.get(f"/api/page-image/{doc_id}/99").status_code == 404      # past the end
    assert guest.get(f"/api/page-image/{doc_id}/0").status_code == 400       # not 1-based
    assert guest.get("/api/page-image/..%2f..%2fetc/1").status_code in (400, 404)
    assert guest.get("/api/page-image/notahexid/1").status_code == 400




def test_cache_lives_outside_uploads(guest):
    """The orphan sweep walks uploads/; previews must not be in its path."""
    doc_id = guest.post("/api/uploads", files={"file": ("t.pdf", _make_pdf(), "application/pdf")}).json()["doc_id"]
    guest.get(f"/api/page-image/{doc_id}/1")
    import os
    from pathlib import Path
    uploads = Path(os.environ["GAMMA_DATA_DIR"]) / "users" / "guest" / "uploads"
    assert not list(uploads.rglob("*.jpg"))
    assert list((uploads.parent / "pagecache").rglob("*.jpg"))
