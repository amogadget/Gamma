"""Every cross-page writer keeps native payloads anchored to their document."""
import pytest

from ai_fixtures import org, folder
from gamma.ai_tools import run_agent_tool
from test_native_ai_protection import ink_block, audio_block, note_block


@pytest.mark.parametrize("transport", ["api", "ai"])
@pytest.mark.parametrize("kind", ["ink", "audio", "note", "ancestor"])
def test_native_subtrees_cannot_move_to_another_page(org, transport, kind):
    client, ids = org
    if kind == "audio":
        block_id, _ = audio_block(client, ids["a"])
    else:
        ink_id, _ = ink_block(client, ids["a"])
        block_id = note_block(client, ink_id) if kind == "note" else ink_id
        if kind == "ancestor":
            holder = client.post("/api/blocks", json={"parent_id": ids["a"], "content": "Group"}).json()
            moved = client.post(f"/api/pages/{ids['a']}/ops", json={"ops": [
                {"op": "move", "id": ink_id, "parent": holder["id"]}]})
            assert moved.status_code == 200, moved.text
            block_id = holder["id"]
    before = client.get(f"/api/blocks/{block_id}/subtree").json()
    if transport == "api":
        response = client.post(f"/api/blocks/{block_id}/reorder", json={"parent_id": ids["b"]})
        assert response.status_code == 409, response.text
    else:
        text, action = run_agent_tool(ids["ws"], folder("readout"), "move_block", {
            "block_id": block_id, "parent_id": ids["b"]})
        assert text.startswith("error: native"), text
        assert action["kind"] == "error"
    assert client.get(f"/api/blocks/{block_id}/subtree").json() == before
