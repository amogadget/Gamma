"""The AI agent is a generic writer — so the native reserved-field guards must
cover it, and its ordinary content edits on a native annotation must still work.

The agent's block writes go through ``gamma/ops.py`` (``apply_ops`` with
``client="ai"``), which is exactly where the guards live, so this file pins both
halves of that contract: the payload nobody but the iPad endpoints may change,
and the text the agent is still allowed to write.
"""

import struct
import uuid
import zlib

from ai_fixtures import folder, org, props  # noqa: F401  (fixtures)
from gamma.ai_tools import agent_tools, run_agent_tool

# The properties that describe a native payload: writing any of them through a
# generic writer must be refused (gamma/native_ink.py).
INK_RESERVED = ("type", "ink_asset", "preview_asset", "replay_asset", "ink_revision",
                "bounds", "crop_box", "coordinate_space", "pdf_page")
AUDIO_RESERVED = ("type", "audio_state", "segments", "duration", "replay_events",
                  "audio_revision")
WRITER_TOOLS = ("edit_block", "create_block", "move_block", "rename_page", "move_page")


def png_bytes(width=3, height=3, rgba=(0, 0, 0, 0)):
    raw = b"".join(b"\x00" + bytes(rgba) * width for _ in range(height))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _asset(c, data, ext, ctype):
    r = c.post("/api/assets", files={"file": (f"drawing.{ext}", data, ctype)})
    assert r.status_code == 200, r.text
    return r.json()["url"]


def ink_block(c, page_id, **overrides):
    """One native ink annotation on ``page_id``; returns (block, properties)."""
    body = {"parent_id": page_id, "pdf_page": 1,
            "ink_asset": _asset(c, b"agent protection drawing", "pkdrawing",
                                "application/octet-stream"),
            "preview_asset": _asset(c, png_bytes(), "png", "image/png"),
            "bounds": {"x": 10, "y": 10, "width": 30, "height": 20},
            "crop_box": {"width": 612, "height": 792}, "expected_revision": 0, **overrides}
    block_id = str(uuid.uuid4())
    r = c.put(f"/api/blocks/{block_id}/ink", json=body)
    assert r.status_code == 200, r.text
    return block_id, r.json()["properties"]


def audio_block(c, page_id):
    block_id = str(uuid.uuid4())
    segment = {"id": str(uuid.uuid4()),
               "asset": _asset(c, b"\x00\x00\x00\x14ftypM4A \x00\x00\x00\x00audio", "m4a",
                               "audio/mp4"),
               "duration": 2.0}
    r = c.put(f"/api/blocks/{block_id}/audio", json={
        "parent_id": page_id, "expected_revision": 0, "audio_state": "stopped",
        "segments": [segment]})
    assert r.status_code == 200, r.text
    return block_id, r.json()["properties"]


def note_block(c, ink_id):
    block_id = str(uuid.uuid4())
    r = c.put(f"/api/blocks/{block_id}/note", json={
        "parent_id": ink_id, "content": "written on the iPad", "expected_revision": 0})
    assert r.status_code == 200, r.text
    return block_id


def test_agent_edits_native_content_without_touching_the_payload(org):
    c, ids = org
    page, scope = ids["a"], folder("readout")
    ink_id, ink_created = ink_block(c, page)
    audio_id, audio_created = audio_block(c, page)
    note_id = note_block(c, ink_id)

    # An ink annotation's caption is ordinary note text: the agent may write it.
    text, action = run_agent_tool(ids["ws"], scope, "edit_block",
                                  {"block_id": ink_id, "content": "AI caption"})
    assert text.startswith("ok"), text
    assert action["kind"] == "edit"
    ink = props(c, ink_id)["properties"]
    assert props(c, ink_id)["content"] == "AI caption"
    for key in INK_RESERVED:
        assert ink.get(key) == ink_created.get(key), key
    # The revision CAS the iPad client relies on is untouched by the agent edit.
    assert c.put(f"/api/blocks/{ink_id}/ink", json={
        "parent_id": page, "pdf_page": 1, "ink_asset": ink_created["ink_asset"],
        "preview_asset": ink_created["preview_asset"],
        "bounds": {"x": 11, "y": 10, "width": 30, "height": 20},
        "crop_box": {"width": 612, "height": 792}, "expected_revision": 1}).status_code == 200

    # The same for a recording's note text.
    text, _ = run_agent_tool(ids["ws"], scope, "edit_block",
                             {"block_id": audio_id, "content": "AI summary of the recording"})
    assert text.startswith("ok"), text
    recording = props(c, audio_id)
    assert recording["content"] == "AI summary of the recording"
    for key in AUDIO_RESERVED:
        assert recording["properties"].get(key) == audio_created.get(key), key

    # A native note's text IS its payload, so the guard moves the outbox
    # revision: the agent may write it, and a queued offline save that still
    # expects the old revision conflicts instead of overwriting the agent.
    text, _ = run_agent_tool(ids["ws"], scope, "edit_block",
                             {"block_id": note_id, "content": "AI rewrote the note"})
    assert text.startswith("ok"), text
    assert props(c, note_id)["properties"]["note_revision"] == 2
    stale = c.put(f"/api/blocks/{note_id}/note", json={
        "parent_id": ink_id, "content": "offline", "expected_revision": 1})
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["current_revision"] == 2
    fresh = c.put(f"/api/blocks/{note_id}/note", json={
        "parent_id": ink_id, "content": "offline", "expected_revision": 2})
    assert fresh.status_code == 200 and fresh.json()["properties"]["note_revision"] == 3

    # The agent can still read what it edited.
    text, _ = run_agent_tool(ids["ws"], scope, "read_block", {"block_id": ink_id})
    assert "AI caption" in text


def test_agent_tool_surface_cannot_claim_native_fields(org):
    c, ids = org
    page, scope = ids["a"], folder("readout")
    ink_id, ink_created = ink_block(c, page)
    _, audio_created = audio_block(c, page)

    # 1. No agent tool accepts a free-form properties argument at all, so the
    #    model cannot even express a reserved-field write.
    specs = {t["name"]: t for t in agent_tools("folder")}
    for name in WRITER_TOOLS:
        assert name in specs
        args = set(specs[name]["parameters"]["properties"])
        assert not args & {"properties", "props", "payload", "meta", "metadata"}, name

    # 2. create_block writes content only: a child of an ink annotation is a
    #    plain note, never a second annotation claiming the same payload.
    before = props(c, ink_id)["properties"]
    text, action = run_agent_tool(ids["ws"], scope, "create_block",
                                  {"parent_id": ink_id, "content": "AI child note"})
    assert text.startswith("ok"), text
    created = props(c, action["block_id"])
    assert created["properties"] == {} and created["parent_id"] == ink_id
    assert props(c, ink_id)["properties"] == before

    # 3. The AI's one real property write (move_page files a page into a
    #    folder, through apply_ops) still works on a page carrying native
    #    children: unrelated properties are not over-blocked.
    text, _ = run_agent_tool(ids["ws"], scope, "move_page",
                             {"page_id": page, "folder": "readout/native"})
    assert text.startswith("ok"), text
    page_props = props(c, page)["properties"]
    assert page_props["folder"] == "readout/native"
    assert page_props["doc_id"] == "d" * 24
    assert props(c, ink_id)["properties"]["ink_asset"] == ink_created["ink_asset"]
    for key in INK_RESERVED:
        assert props(c, ink_id)["properties"].get(key) == ink_created.get(key), key


def test_agent_move_and_rename_keep_native_payloads_intact(org):
    c, ids = org
    page, scope = ids["a"], folder("readout")
    ink_id, ink_created = ink_block(c, page)
    sibling = c.post("/api/blocks", json={"parent_id": page, "content": "sibling"}).json()

    # A same-page reorder is an op on the row's position only.
    text, _ = run_agent_tool(ids["ws"], scope, "move_block",
                             {"block_id": ink_id, "parent_id": page,
                              "after_id": sibling["id"]})
    assert text.startswith("ok"), text
    moved = props(c, ink_id)
    assert moved["parent_id"] == page
    for key in INK_RESERVED:
        assert moved["properties"].get(key) == ink_created.get(key), key
    # Still a valid native annotation: the iPad client can save against it.
    saved = c.put(f"/api/blocks/{ink_id}/ink", json={
        "parent_id": page, "pdf_page": 1, "ink_asset": ink_created["ink_asset"],
        "preview_asset": ink_created["preview_asset"],
        "bounds": {"x": 12, "y": 10, "width": 30, "height": 20},
        "crop_box": {"width": 612, "height": 792}, "expected_revision": 1})
    assert saved.status_code == 200, saved.text
    assert saved.json()["properties"]["ink_revision"] == 2
