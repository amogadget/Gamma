"""Share access requires an actual asset URL, not a bare filename mention."""
from fastapi.testclient import TestClient

from conftest import login, make_page, make_user
from gamma.app import app


def test_share_does_not_grant_asset_by_bare_filename():
    make_user("native-ref-owner", "ref-password")
    with login("native-ref-owner", "ref-password") as owner:
        stored = owner.post("/api/assets", files={
            "file": ("source.pkdrawing", b"private unreferenced source", "application/octet-stream")})
        assert stored.status_code == 200
        asset = stored.json()
        page = make_page(owner, "Reference confinement", properties={"doc_id": "f" * 24})
        block = owner.post("/api/blocks", json={
            "parent_id": page["id"], "content": "Digest log: " + asset["filename"],
            "properties": {"filename_only": asset["filename"]}}).json()
        shared = owner.post(f"/api/share/{page['id']}", json={"audience": "anyone", "role": "view"})
        assert shared.status_code == 200
        token = shared.json()["token"]
        with TestClient(app) as reader:
            for prefix in ("/api/assets/", "/api/uploads/"):
                assert reader.get(prefix + asset["filename"], params={"share": token}).status_code == 404
            attached = owner.put(f"/api/blocks/{block['id']}", json={"content": asset["url"]})
            assert attached.status_code == 200
            assert reader.get(asset["url"], params={"share": token}).status_code == 200
            attached = owner.put(f"/api/blocks/{block['id']}", json={
                "content": "", "properties": {"attachment": "/api/uploads/" + asset["filename"]}})
            assert attached.status_code == 200
            assert reader.get(asset["url"], params={"share": token}).status_code == 200
