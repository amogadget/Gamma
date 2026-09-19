"""Startup stays SDK-free; simultaneous first MCP calls share one transport."""

import os
from pathlib import Path
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from conftest import make_user


def test_normal_startup_does_not_load_mcp_sdk(tmp_path):
    code = """
import sys
from fastapi.testclient import TestClient
from gamma.app import app
with TestClient(app, base_url='http://localhost') as client:
    assert client.get('/api/health').status_code == 200
    assert client.get('/.well-known/oauth-authorization-server').status_code == 200
    assert client.post('/mcp', json={}).status_code == 401
    assert not any(name == 'mcp' or name.startswith('mcp.') for name in sys.modules)
"""
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, "GAMMA_DATA_DIR": str(tmp_path)},
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr


def test_concurrent_first_mcp_requests_and_lifespan_restart():
    from gamma.app import app
    from gamma.integrations import create_token

    ws = make_user("startup-reader", "pw")
    token = create_token("startup-reader", ws, "Startup test", 1)["token"]
    # Re-entering the same app must create a transport for the new event loop.
    for _ in range(2):
        with TestClient(app, base_url="http://localhost") as client:
            def request(index):
                return client.post("/mcp", headers={
                    "Authorization": "Bearer " + token,
                    "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2025-11-25",
                }, json={"jsonrpc": "2.0", "id": index, "method": "tools/list"})

            with ThreadPoolExecutor(max_workers=4) as pool:
                responses = list(pool.map(request, range(4)))
            for response in responses:
                assert response.status_code == 200, response.text
                assert "tools" in response.json()["result"]
