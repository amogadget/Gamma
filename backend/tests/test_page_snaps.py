"""/api/page-snaps — the synced recents-card cover store."""

from fastapi.testclient import TestClient

JPEG = "data:image/jpeg;base64,/9j/AAAA"


def test_snaps_start_empty(guest):
    r = guest.get("/api/page-snaps")
    assert r.status_code == 200
    assert r.json()["snaps"] == {}


def test_snap_roundtrip_and_delete(guest):
    r = guest.put("/api/page-snaps/p1", json={"img": JPEG, "at": "2026-01-01T00:00:00Z"})
    assert r.status_code == 200
    assert r.json()["at"] == "2026-01-01T00:00:00Z"

    snaps = guest.get("/api/page-snaps").json()["snaps"]
    assert snaps["p1"] == {"img": JPEG, "at": "2026-01-01T00:00:00Z"}

    r = guest.delete("/api/page-snaps/p1")
    assert r.status_code == 200
    assert guest.get("/api/page-snaps").json()["snaps"] == {}


def test_snap_newest_at_wins(guest):
    guest.put("/api/page-snaps/p2", json={"img": JPEG + "new", "at": "2026-01-02T00:00:00Z"})
    # A stale capture from a device with an older clock must not clobber it.
    r = guest.put("/api/page-snaps/p2", json={"img": JPEG + "old", "at": "2026-01-01T00:00:00Z"})
    assert r.status_code == 200
    assert r.json()["at"] == "2026-01-02T00:00:00Z"
    assert guest.get("/api/page-snaps").json()["snaps"]["p2"]["img"] == JPEG + "new"
    guest.delete("/api/page-snaps/p2")


def test_snaps_after_filter(guest):
    guest.put("/api/page-snaps/pa", json={"img": JPEG, "at": "2026-01-01T00:00:00Z"})
    guest.put("/api/page-snaps/pb", json={"img": JPEG, "at": "2026-01-03T00:00:00Z"})
    snaps = guest.get("/api/page-snaps", params={"after": "2026-01-02T00:00:00Z"}).json()["snaps"]
    assert set(snaps) == {"pb"}
    guest.delete("/api/page-snaps/pa")
    guest.delete("/api/page-snaps/pb")


def test_snaps_pruned_to_cap(guest):
    from gamma.db import PAGE_SNAPS_CAP

    for i in range(PAGE_SNAPS_CAP + 5):
        r = guest.put(f"/api/page-snaps/cap{i:03d}", json={"img": JPEG, "at": f"2026-02-01T00:00:{i:02d}Z"})
        assert r.status_code == 200
    snaps = guest.get("/api/page-snaps").json()["snaps"]
    assert len(snaps) == PAGE_SNAPS_CAP
    # The newest survive, the oldest were evicted.
    assert f"cap{PAGE_SNAPS_CAP + 4:03d}" in snaps and "cap000" not in snaps
    for pid in list(snaps):
        guest.delete(f"/api/page-snaps/{pid}")


def test_snap_validation(guest):
    # Not a JPEG data URL
    assert guest.put("/api/page-snaps/px", json={"img": "data:image/png;base64,AAAA"}).status_code == 400
    assert guest.put("/api/page-snaps/px", json={"img": "<script>"}).status_code == 400
    # Bad page id (path traversal shapes)
    assert guest.put("/api/page-snaps/%2E%2E", json={"img": JPEG}).status_code == 400
    # Oversized
    big = "data:image/jpeg;base64," + "A" * (210 * 1024)
    assert guest.put("/api/page-snaps/px", json={"img": big}).status_code == 413


def test_snaps_require_session(client):
    from gamma.app import app

    anon = TestClient(app)
    assert anon.get("/api/page-snaps").status_code == 401
    assert anon.put("/api/page-snaps/p1", json={"img": JPEG}).status_code == 401
    assert anon.delete("/api/page-snaps/p1").status_code == 401
