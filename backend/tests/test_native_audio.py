"""Native audio recordings: `.m4a` assets, the recording block, replay events.

Ported from the standalone native backend onto this branch's model — same
endpoints and semantics, workspace-scoped auth, ops write path and reserved
audio properties. Audio stays opaque to the server: only the container header
is checked, never the codec.
"""

import io
import json
import uuid
import zipfile

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from conftest import login, make_page, make_user


def m4a_bytes(payload=b"audio"):
    """Minimal plausible ISO-BMFF ftyp box; audio remains opaque to the server."""
    size = (16 + len(payload)).to_bytes(4, "big")
    return size + b"ftyp" + b"M4A " + (0).to_bytes(4, "big") + payload


@pytest.fixture
def owner():
    make_user("audio-owner", "audio-password")
    with login("audio-owner", "audio-password") as client:
        yield client


def audio_asset(client, data=None):
    data = m4a_bytes() if data is None else data
    result = client.post("/api/assets", files={"file": ("recording.m4a", data, "audio/mp4")})
    assert result.status_code == 200, result.text
    return result.json()


def recording_payload(client):
    page = make_page(client, properties={"doc_id": "abcdefabcdefabcdefabcdef12"})
    asset = audio_asset(client)
    return page, asset, {"parent_id": page["id"], "expected_revision": 0,
                         "audio_state": "stopped", "segments": [{
                             "id": str(uuid.uuid4()), "asset": asset["url"], "duration": 2.5}]}


def test_m4a_ftyp_auth_quota_and_private_alias(owner, monkeypatch):
    from gamma import native_ink as native_core
    from gamma.app import app
    uploaded = audio_asset(owner)
    served = owner.get(uploaded["url"])
    assert served.headers["content-type"].startswith("audio/mp4")
    assert served.content == m4a_bytes()
    assert served.headers["cache-control"] == "private, no-cache"
    assert owner.get(uploaded["url"].replace("/assets/", "/uploads/")).status_code == 200
    with TestClient(app) as anonymous:
        assert anonymous.get(uploaded["url"]).status_code == 401
    make_user("audio-other", "password")
    with login("audio-other", "password") as other:
        assert other.get(uploaded["url"]).status_code == 404
    assert owner.post("/api/assets", files={"file": ("bad.m4a", b"not-mp4", "audio/mp4")}).status_code == 400
    assert owner.post("/api/assets", files={"file": ("x.mp3", m4a_bytes(), "audio/mpeg")}).status_code == 400

    def deny(*args):
        raise HTTPException(507, "quota")
    monkeypatch.setattr(native_core, "check_upload_allowed", deny)
    assert owner.post("/api/assets", files={"file": (
        "new.m4a", m4a_bytes(b"new"), "audio/mp4")}).status_code == 507


def test_audio_create_idempotent_update_conflict_and_preservation(owner):
    page, asset, body = recording_payload(owner)
    block_id = str(uuid.uuid4())
    url = f"/api/blocks/{block_id}/audio"
    first = owner.put(url, json=body)
    assert first.status_code == 200, first.text
    block = first.json()
    assert block["content"] == "" and block["properties"]["audio_revision"] == 1
    assert block["properties"]["segments"][0]["start_time"] == 0
    assert block["properties"]["duration"] == 2.5
    assert owner.put(url, json=body).json() == block
    assert owner.put(f"/api/blocks/{block_id}", json={
        "content": "recording note", "properties": {"custom": 7}}).status_code == 200
    child = owner.post("/api/blocks", json={"parent_id": block_id, "content": "child"}).json()
    other = audio_asset(owner, m4a_bytes(b"second"))
    changed = {**body, "expected_revision": 1, "audio_state": "paused",
               "segments": [{"id": body["segments"][0]["id"], "asset": body["segments"][0]["asset"],
                             "duration": 2.5},
                            {"id": str(uuid.uuid4()), "asset": other["url"], "duration": 3.0}]}
    assert owner.put(url, json={**changed, "expected_revision": 0,
                                "audio_state": "recording"}).status_code == 409
    updated = owner.put(url, json=changed)
    assert updated.status_code == 200, updated.text
    saved = updated.json()
    assert saved["content"] == "recording note" and saved["properties"]["custom"] == 7
    assert saved["properties"]["audio_revision"] == 2
    assert saved["properties"]["segments"][1]["start_time"] == 2.5
    assert saved["properties"]["duration"] == 5.5
    assert owner.get(f"/api/blocks/{block_id}/children").json()["children"][0]["id"] == child["id"]
    assert owner.put(url, json=changed).json() == saved
    # Reserved audio fields are closed to generic writers.
    assert owner.put(f"/api/blocks/{block_id}", json={
        "properties": {"audio_state": "stopped"}}).status_code == 409
    assert owner.put(f"/api/blocks/{block_id}", json={
        "properties": {"replay_events": []}}).status_code == 409
    assert owner.put(f"/api/blocks/{block_id}", json={"content": "still editable"}).status_code == 200


def test_audio_replay_timeline_validation_and_compatibility(owner):
    page, asset, body = recording_payload(owner)
    block_id = str(uuid.uuid4())
    url = f"/api/blocks/{block_id}/audio"
    event = {"id": str(uuid.uuid4()), "kind": "stroke",
             "segment_id": body["segments"][0]["id"], "start": 0.1, "end": 0.9,
             "pdf_page": 1, "block_id": "ink-outbox-id", "stroke_id": "stroke-1"}
    first = owner.put(url, json={**body, "replay_events": [event]})
    assert first.status_code == 200, first.text
    saved = first.json()
    assert saved["properties"]["replay_events"] == [event]
    assert owner.put(url, json={**body, "replay_events": [event]}).json() == saved

    # Old clients omit the field: their state update must retain the timeline.
    omitted = {**body, "expected_revision": 1, "audio_state": "paused"}
    updated = owner.put(url, json=omitted)
    assert updated.status_code == 200, updated.text
    assert updated.json()["properties"]["replay_events"] == [event]
    changed = {**body, "expected_revision": 1, "replay_events": [{**event, "end": 1.0}]}
    assert owner.put(url, json=changed).status_code == 409
    cleared = owner.put(url, json={**body, "expected_revision": 2, "replay_events": []})
    assert cleared.status_code == 200
    assert cleared.json()["properties"]["replay_events"] == []

    for bad in (
        [{**event, "segment_id": str(uuid.uuid4())}],
        [{**event, "start": -1}],
        [{**event, "start": 2, "end": 1}],
        [event, {**event}],
        [{k: v for k, v in event.items() if k != "block_id"}],
    ):
        assert owner.put(url, json={**body, "expected_revision": 3,
                                    "replay_events": bad}).status_code == 422


def test_audio_segment_duplicates_and_scope_rejection(owner):
    page, asset, body = recording_payload(owner)
    duplicate = {**body, "segments": [{**body["segments"][0]}, {**body["segments"][0]}]}
    assert owner.put(f"/api/blocks/{uuid.uuid4()}/audio", json=duplicate).status_code == 422
    assert owner.put(f"/api/blocks/{uuid.uuid4()}/audio", json={
        **body, "parent_id": make_page(owner)["id"]}).status_code == 409
    assert owner.put("/api/blocks/not-a-uuid/audio", json=body).status_code == 422
    # A segment asset that was never uploaded, or is not an M4A, is refused.
    assert owner.put(f"/api/blocks/{uuid.uuid4()}/audio", json={**body, "segments": [
        {**body["segments"][0], "asset": "/api/assets/" + "a" * 64 + ".m4a"}]}).status_code == 404
    assert owner.put(f"/api/blocks/{uuid.uuid4()}/audio", json={**body, "segments": [
        {**body["segments"][0], "asset": "https://example.com/x.m4a"}]}).status_code == 422


def test_audio_assets_backup_restore_and_readable_exports(owner):
    page, asset, body = recording_payload(owner)
    block_id = str(uuid.uuid4())
    assert owner.put(f"/api/blocks/{block_id}/audio", json=body).status_code == 200
    filename = asset["filename"]
    for mode in ("gamma", "readable"):
        response = owner.get(f"/api/pages/{page['id']}/export?mode={mode}")
        assert response.status_code == 200, response.text
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            names = archive.namelist()
            assert (("uploads/" if mode == "gamma" else "assets/") + filename) in names
            if mode == "readable":
                md = archive.read(next(n for n in names if n.endswith(".md"))).decode()
                assert filename in md
        if mode == "gamma":
            restored = owner.post("/api/import-data?mode=merge", files={
                "file": ("audio.zip", response.content, "application/zip")})
            assert restored.status_code == 200, restored.text
    full = owner.get("/api/export")
    assert full.status_code == 200
    with zipfile.ZipFile(io.BytesIO(full.content)) as archive:
        assert "uploads/" + filename in archive.namelist()
    # The recorded segment references survive a JSON round trip (what a client
    # reads back is what it sent).
    block = owner.get(f"/api/blocks/{block_id}").json()
    assert json.loads(json.dumps(block["properties"]["segments"]))[0]["asset"] == asset["url"]
