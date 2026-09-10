import uuid

from conftest import make_page


def test_native_highlight_is_ordinary_block_and_retry_preserves_web_edits(guest):
    page = make_page(guest, properties={"doc_id": "abc123"})
    rect = {"x1": 10, "y1": 20, "x2": 30, "y2": 40, "width": 100, "height": 200, "pageNumber": 1}
    body = {"parent_id": page["id"], "quote": "Selected text", "color": "#ffe28f",
            "pdf_position": {"pageNumber": 1, "boundingRect": rect, "rects": [rect], "area": False}}
    identity = str(uuid.uuid4())
    route = f"/api/blocks/{identity}/highlight"
    response = guest.put(route, json=body)
    assert response.status_code == 200, response.text
    block = response.json()
    assert block["properties"]["highlight_id"] == identity
    assert block["properties"]["pdf_page"] == 1
    assert guest.put(route, json=body).json() == block
    guest.put(f"/api/blocks/{identity}", json={"content": "Web comment", "properties": {"color": "#9bcdff"}})
    retry = guest.put(route, json=body).json()
    assert retry["content"] == "Web comment"
    assert retry["properties"]["color"] == "#9bcdff"
    collision = guest.post("/api/blocks", json={"parent_id": page["id"], "content": "unrelated"}).json()
    assert guest.put(f"/api/blocks/{collision['id']}/highlight", json=body).status_code in (409, 422)
    invalid = {**body, "pdf_position": {**body["pdf_position"], "pageNumber": 2}}
    assert guest.put(f"/api/blocks/{uuid.uuid4()}/highlight", json=invalid).status_code == 422


def test_native_highlight_requires_authentication(client):
    # Clear this TestClient's cookie for a read-only scope check.
    from fastapi.testclient import TestClient
    from gamma.app import app
    with TestClient(app) as anonymous:
        rect = {"x1": 1, "y1": 1, "x2": 2, "y2": 2, "width": 10, "height": 10, "pageNumber": 1}
        response = anonymous.put(f"/api/blocks/{uuid.uuid4()}/highlight", json={
            "parent_id": "page", "quote": "text", "color": "#ffe28f",
            "pdf_position": {"pageNumber": 1, "boundingRect": rect, "rects": [rect]}})
        assert response.status_code == 401
