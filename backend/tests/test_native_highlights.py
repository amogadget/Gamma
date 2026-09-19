"""Native text highlights: ``PUT /api/blocks/{id}/highlight``.

Create-only and retry-safe for a client-minted UUID, but otherwise an ordinary
page-scoped highlight block — later Web edits survive a retry, and an unrelated
block's UUID is never claimed.
"""

import uuid

from fastapi.testclient import TestClient

from conftest import make_page


def _rect(page=1):
    return {"x1": 10, "y1": 20, "x2": 30, "y2": 40, "width": 100, "height": 200,
            "pageNumber": page}


def _body(page_id, page=1):
    rect = _rect(page)
    return {"parent_id": page_id, "quote": "Selected text", "color": "#ffe28f",
            "pdf_position": {"pageNumber": page, "boundingRect": rect, "rects": [rect],
                             "area": False}}


def test_native_highlight_is_ordinary_block_and_retry_preserves_web_edits(guest):
    page = make_page(guest, properties={"doc_id": "abc123"})
    body = _body(page["id"])
    identity = str(uuid.uuid4())
    route = f"/api/blocks/{identity}/highlight"
    response = guest.put(route, json=body)
    assert response.status_code == 200, response.text
    block = response.json()
    assert block["properties"]["highlight_id"] == identity
    assert block["properties"]["pdf_page"] == 1
    assert block["properties"]["quote"] == "Selected text"
    assert block["parent_id"] == page["id"] and block["content"] == ""
    assert guest.put(route, json=body).json() == block
    guest.put(f"/api/blocks/{identity}", json={"content": "Web comment",
                                               "properties": {"color": "#9bcdff"}})
    retry = guest.put(route, json=body).json()
    assert retry["content"] == "Web comment"
    assert retry["properties"]["color"] == "#9bcdff"
    # The block is an ordinary highlight for every other reader of the page.
    children = guest.get(f"/api/blocks/{page['id']}/children").json()["children"]
    assert [c["id"] for c in children] == [identity]
    collision = guest.post("/api/blocks", json={"parent_id": page["id"],
                                                "content": "unrelated"}).json()
    # A non-UUID block id is simply not a native identity.
    assert guest.put(f"/api/blocks/{collision['id']}/highlight", json=body).status_code == 422
    # A UUID that already belongs to a plain block is refused, never hijacked.
    occupied = str(uuid.uuid4())
    assert guest.post(f"/api/pages/{page['id']}/ops", json={"client": "web", "ops": [
        {"op": "insert", "id": occupied, "parent": page["id"],
         "content": "ordinary block", "props": {}}]}).status_code == 200
    hijack = guest.put(f"/api/blocks/{occupied}/highlight", json=body)
    assert hijack.status_code == 409, hijack.text
    assert guest.get(f"/api/blocks/{occupied}").json()["content"] == "ordinary block"
    invalid = {**body, "pdf_position": {**body["pdf_position"], "pageNumber": 2}}
    assert guest.put(f"/api/blocks/{uuid.uuid4()}/highlight", json=invalid).status_code == 422
    assert guest.put(f"/api/blocks/not-a-uuid/highlight", json=body).status_code == 422
    assert guest.put(f"/api/blocks/{uuid.uuid4()}/highlight", json={
        **body, "parent_id": make_page(guest, "No PDF")["id"]}).status_code == 409


def test_native_highlight_requires_authentication(client):
    from gamma.app import app
    with TestClient(app) as anonymous:
        response = anonymous.put(f"/api/blocks/{uuid.uuid4()}/highlight", json=_body("page"))
        assert response.status_code == 401
