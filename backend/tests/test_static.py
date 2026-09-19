"""The SPA static route (gamma/app.py): hashed assets cache forever, unhashed
files revalidate and answer 304 when the browser already holds them."""

from fastapi.testclient import TestClient

from gamma import config
from gamma.app import create_app


def _static_client(tmp_path, monkeypatch):
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)")
    (tmp_path / "favicon.svg").write_text("<svg/>")
    (tmp_path / "index.html").write_text("<!doctype html><title>Gamma</title>")
    monkeypatch.setattr(config, "STATIC_DIR", str(tmp_path))
    return TestClient(create_app())


def test_hashed_assets_are_immutable(tmp_path, monkeypatch):
    c = _static_client(tmp_path, monkeypatch)
    r = c.get("/assets/index-abc123.js")
    assert r.status_code == 200
    assert "immutable" in r.headers["cache-control"]


def test_unhashed_files_revalidate_with_a_real_304(tmp_path, monkeypatch):
    c = _static_client(tmp_path, monkeypatch)
    r = c.get("/favicon.svg")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"
    etag = r.headers["etag"]
    again = c.get("/favicon.svg", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.headers["etag"] == etag
    assert again.content == b""
    # A changed file (new size) gets a new tag and the body again.
    (tmp_path / "favicon.svg").write_text("<svg></svg>")
    changed = c.get("/favicon.svg", headers={"If-None-Match": etag})
    assert changed.status_code == 200 and changed.headers["etag"] != etag


def test_index_html_falls_back_and_revalidates(tmp_path, monkeypatch):
    c = _static_client(tmp_path, monkeypatch)
    r = c.get("/?page=xyz")
    assert r.status_code == 200 and "Gamma" in r.text
    assert r.headers["cache-control"] == "no-cache"
    assert c.get("/some/deep/route", headers={"If-None-Match": r.headers["etag"]}).status_code == 304
