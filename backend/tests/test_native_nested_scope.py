"""Native edits follow their PDF page, preserving same-page outliner nesting."""
import uuid

import pytest
from conftest import make_page
from test_native_ink import owner, payload


@pytest.mark.parametrize("kind", ["ink", "audio"])
def test_nested_native_save_preserves_parent_and_rejects_other_page(owner, kind):
    if kind == "ink":
        body = payload(owner)
        revision_key = "ink_revision"
    else:
        page = make_page(owner, "Recording notebook", properties={"doc_id": "e" * 24})
        body = {"parent_id": page["id"], "audio_state": "paused", "segments": [], "expected_revision": 0}
        revision_key = "audio_revision"
    page_id = body["parent_id"]
    block_id = str(uuid.uuid4())
    saved = owner.put(f"/api/blocks/{block_id}/{kind}", json=body)
    assert saved.status_code == 200, saved.text
    holder = owner.post("/api/blocks", json={"parent_id": page_id, "content": "Nested group"}).json()
    moved = owner.post(f"/api/pages/{page_id}/ops", json={"client": "web", "ops": [
        {"op": "move", "id": block_id, "parent": holder["id"]}]})
    assert moved.status_code == 200, moved.text
    # iPad names its PDF page, not the current outliner parent. Exact retry is
    # still a no-op even with the stale create expectation.
    retry = owner.put(f"/api/blocks/{block_id}/{kind}", json=body)
    assert retry.status_code == 200, retry.text
    assert retry.json()["parent_id"] == holder["id"]
    assert retry.json()["properties"][revision_key] == 1
    changed = {**body, "expected_revision": 1}
    if kind == "ink":
        changed["bounds"] = {**body["bounds"], "x": body["bounds"]["x"] + 1}
    else:
        changed["audio_state"] = "stopped"
    updated = owner.put(f"/api/blocks/{block_id}/{kind}", json=changed)
    assert updated.status_code == 200, updated.text
    assert updated.json()["parent_id"] == holder["id"]
    assert updated.json()["properties"][revision_key] == 2
    other = make_page(owner, "Other PDF", properties={"doc_id": "d" * 24})
    refused = owner.put(f"/api/blocks/{block_id}/{kind}", json={
        **changed, "parent_id": other["id"], "expected_revision": 2})
    assert refused.status_code == 409
    assert owner.get(f"/api/blocks/{block_id}").json()["parent_id"] == holder["id"]
    if kind == "ink":
        note_id, child_id = str(uuid.uuid4()), str(uuid.uuid4())
        for nid, parent in ((note_id, block_id), (child_id, note_id)):
            note = owner.put(f"/api/blocks/{nid}/note", json={
                "parent_id": parent, "content": "Note below nested ink", "expected_revision": 0})
            assert note.status_code == 200, note.text
            assert note.json()["properties"]["note_revision"] == 1
        edited = owner.put(f"/api/blocks/{child_id}/note", json={
            "parent_id": note_id, "content": "Updated nested note", "expected_revision": 1})
        assert edited.status_code == 200, edited.text
        assert edited.json()["properties"]["note_revision"] == 2
