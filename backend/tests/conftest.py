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


@pytest.fixture(autouse=True)
def _no_upload_grace(monkeypatch):
    """Orphan cleanup skips files younger than storage.UPLOAD_GRACE_S (the
    upload→attach window). Tests upload and delete within milliseconds, so
    the suite runs with no grace; test_pages covers the grace itself."""
    from gamma import storage
    monkeypatch.setattr(storage, "UPLOAD_GRACE_S", 0)
    yield


@pytest.fixture(autouse=True)
def _reset_ratelimit():
    """The whole suite shares one TestClient source IP, so the per-IP login
    throttle would trip mid-run. Clear counters before each test — production
    behavior is unchanged."""
    from gamma import ratelimit
    ratelimit._buckets.clear()
    yield


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


def make_user(username, password, is_admin=0):
    """Create (idempotently) a password account plus its personal workspace.
    Returns the workspace id."""
    import bcrypt
    from gamma import workspaces
    from gamma.db import connect_users_db, page_now

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, is_admin, created_at) VALUES (?, ?, 0, ?, ?)",
                (username, bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(), is_admin, page_now()),
            )
            conn.commit()
    return workspaces.ensure_personal(username)


def workspace_of(username):
    """The account's personal workspace id."""
    from gamma import workspaces
    return workspaces.default_workspace(username)


def login(username, password):
    """A fresh TestClient logged in as the account (cookie persists on it)."""
    from gamma.app import app
    c = TestClient(app)
    r = c.post("/api/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return c


def make_page(guest, title="Test page", properties=None):
    r = guest.post("/api/blocks", json={"parent_id": "root", "content": title})
    assert r.status_code == 200, r.text
    block = r.json()
    if properties:
        r = guest.put(f"/api/blocks/{block['id']}", json={"properties": properties})
        assert r.status_code == 200, r.text
    return block


def require_math_renderer():
    """Guard for assertions that count typeset-math vector paths: they need
    ziamath, a hard requirement (requirements.txt) that is easy to miss when
    the tests run under some other interpreter than backend/venv's. Fail with
    the cause instead of a puzzling path count."""
    try:
        import ziamath  # noqa: F401
    except ImportError:
        pytest.fail("ziamath is not importable — run the tests with backend/venv's python "
                    "(pip install -r requirements.txt)")
