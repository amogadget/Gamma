"""Test bootstrap: the whole suite runs against a throwaway data directory,
with AI providers unconfigured, using FastAPI's in-process TestClient (no
network, no running server needed)."""

import os
import sys
import tempfile
from pathlib import Path

# Must happen BEFORE importing gamma — config reads the environment at import.
os.environ["GAMMA_DATA_DIR"] = tempfile.mkdtemp(prefix="gamma-test-")
for var in ("GAMMA_STATIC_DIR", "GAMMA_AI_ANTHROPIC_API_KEY", "GAMMA_AI_OPENAI_API_KEY",
            "GAMMA_AI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GAMMA_AI_MODELS", "GAMMA_AI_MODEL",
            "GAMMA_ADMIN_USER", "GAMMA_ADMIN_PASSWORD"):
    os.environ.pop(var, None)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="session")
def client():
    from gamma.app import app
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def guest(client):
    """A TestClient logged in as the guest user (cookie persists on the client)."""
    r = client.post("/api/login-guest")
    assert r.status_code == 200, r.text
    return client


def make_page(guest, title="Test page", properties=None):
    r = guest.post("/api/blocks", json={"parent_id": "root", "content": title})
    assert r.status_code == 200, r.text
    block = r.json()
    if properties:
        r = guest.put(f"/api/blocks/{block['id']}", json={"properties": properties})
        assert r.status_code == 200, r.text
    return block
