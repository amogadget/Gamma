"""Actual iOS full-backend boot test; launched by the embedded interpreter."""
import sys
import os
import tempfile
import threading
import queue
import json
import uuid
from pathlib import Path
import certifi
os.environ['SSL_CERT_FILE'] = certifi.where()
assert sys.platform == 'ios'
import bcrypt
from cryptography.fernet import Fernet
from rpds import HashTrieMap
assert bcrypt.checkpw(b'local-test', bcrypt.hashpw(b'local-test', bcrypt.gensalt(rounds=4)))
f = Fernet(Fernet.generate_key()); assert f.decrypt(f.encrypt(b'Gamma local data')) == b'Gamma local data'
assert HashTrieMap({'x': 7})['x'] == 7
import gamma_ios_runtime as runtime
import httpx
import mcp.server.fastmcp  # Warm lazy native dependency closure, not only /health.

root = Path(tempfile.mkdtemp(prefix='gamma-ios-backend-'))
static = Path(__file__).parent / 'frontend'
assert (static / 'index.html').is_file(), 'Bundle the real frontend before running this test'
stop = threading.Event(); ready = queue.Queue(); errors = []
def worker():
    try: runtime.serve(runtime.RuntimeConfig(root, static), ready.put, stop)
    except BaseException as error:
        errors.append(error); ready.put(None)
thread = threading.Thread(target=worker, name='Gamma embedded worker')
thread.start()
try:
    result = ready.get(timeout=60)
    assert result is not None, repr(errors)
    assert runtime.health_probe(result)
    with httpx.Client(base_url=result.url, trust_env=False, timeout=30) as client:
        assert client.get('/api/health').status_code == 403
        client.headers['Cookie'] = result.session_cookie.header() + '; ' + result.capability_cookie.header()
        assert client.get('/').status_code == 200
        session = client.get('/api/session').json()
        assert session['user'] == result.account and session['default_workspace'] == result.workspace
        paths = client.get('/openapi.json').json()['paths']
        for path in ('/api/search', '/api/ai/chat', '/api/assets', '/api/blocks/{block_id}/ink', '/api/workspaces'):
            assert path in paths, path
        client.headers['X-Gamma-Workspace'] = result.workspace
        page_id = str(uuid.uuid4())
        response = client.put('/api/blank-pdfs/' + page_id, json={'title':'Local iPad PDF','page_size':'a4','orientation':'portrait','page_count':2})
        assert response.status_code == 200, (response.status_code, response.text)
        response = client.get('/api/blocks/' + page_id + '/subtree')
        assert response.status_code == 200
        assert response.json()['block']['id'] == page_id
    print('GAMMA_IOS_BACKEND_SMOKE_OK: full FastAPI route assembly, real local identity, native crypto, bundled UI and PDF creation', flush=True)
finally:
    stop.set();thread.join(timeout=25)
    assert not thread.is_alive(), 'Embedded HTTP worker failed to stop'
