"""Real-backend Linux integration (no backend mocks, no real user data).

/tmp/gamma-native-integration-venv/bin/python ipad/scripts/test_embedded_runtime.py

Only this TEST harness launches isolated interpreters: production serve runs
on a worker thread in each interpreter. The isolation exercises import-time
configuration and persisted identity across application launches.
"""
from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import queue
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ipad' / 'EmbeddedBackend'))
sys.path.insert(0, str(ROOT / 'backend'))


def exercise(data: Path, static: Path, phase: str):
    import httpx
    from websockets.sync.client import connect
    from websockets.exceptions import InvalidStatus
    import gamma_ios_runtime as runtime

    config = runtime.RuntimeConfig(data, static)
    secrets_seen = []
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        previous = None
        for run in range(2):
            stopped, ready, errors = threading.Event(), queue.Queue(), []

            def worker():
                try:
                    runtime.serve(config, ready.put, stopped)
                except BaseException as error:
                    errors.append(error)
                    ready.put(None)

            thread = threading.Thread(target=worker, name='native-cpython-worker')
            thread.start()
            result = ready.get(timeout=45)
            if result is None:
                raise AssertionError(f'Worker startup failed: {errors!r}')
            secrets_seen.extend([result.capability, result.session_cookie.value])
            try:
                assert result.url.startswith('http://127.0.0.1:')
                assert result.account.startswith('gamma-local-')
                assert runtime.health_probe(result)
                assert result.capability not in repr(result)
                assert result.session_cookie.value not in repr(result)
                assert result.capability not in repr(result.capability_cookie)
                assert result.capability_cookie.http_only and result.capability_cookie.host_only
                assert result.capability_cookie.same_site == 'Strict'
                if previous:
                    assert result.account == previous.account and result.workspace == previous.workspace
                    assert result.capability != previous.capability
                    assert result.capability_cookie.name != previous.capability_cookie.name
                    assert result.session_cookie.value != previous.session_cookie.value
                cookie = result.session_cookie.header() + '; ' + result.capability_cookie.header()
                with httpx.Client(base_url=result.url, trust_env=False, timeout=15) as client:
                    # Gate covers every route, including otherwise-public static/health/login/docs.
                    for path in ('/', '/assets/probe.txt', '/api/health', '/api/session', '/openapi.json'):
                        assert client.get(path).status_code == 403, path
                    assert client.post('/api/login', json={}).status_code == 403
                    cap_headers = {result.capability_header: result.capability}
                    assert client.get('/api/health', headers=cap_headers).status_code == 200
                    assert client.get('/api/session', headers=cap_headers).json()['user'] is None
                    assert client.put('/api/blank-pdfs/' + str(uuid.uuid4()), headers=cap_headers,
                                      json={}).status_code == 401
                    client.headers['Cookie'] = cookie
                    assert client.get('/').text == '<!doctype html><title>bundled fixture</title>'
                    assert client.get('/assets/probe.txt').text == 'bundled-static'
                    for origin in ('https://attacker.example', 'null', 'http://localhost:123',
                                   'http://127.0.0.1:1', result.url + '/'):
                        assert client.get('/api/health', headers={'Origin': origin}).status_code == 403
                    for host in ('attacker.example', 'localhost', '127.0.0.1', '127.0.0.1:1'):
                        assert client.get('/api/health', headers={'Host': host}).status_code == 403
                    assert client.get('/api/health', headers={'Origin': result.url}).status_code == 200
                    assert client.get('/api/health', headers={'Cookie': result.session_cookie.header()}).status_code == 403
                    if previous:
                        assert client.get('/api/health', headers={'Cookie': previous.capability_cookie.header()}).status_code == 403
                    session = client.get('/api/session').json()
                    assert session['user'] == result.account and session['is_admin'] and not session['is_guest']
                    assert session['default_workspace'] == result.workspace
                    assert any(w['id'] == result.workspace and w['role'] == 'owner' for w in session['workspaces'])
                    paths = client.get('/openapi.json').json()['paths']
                    for path in ('/api/ai/chat', '/api/upload-file', '/api/search', '/api/workspaces',
                                 '/api/export', '/api/blank-pdfs/{page_id}', '/api/pages/{page_id}/ops'):
                        assert path in paths, path
                    assert len(paths) > 100
                    state_file = data.parent / 'expected.json'
                    if phase == 'first' and run == 0:
                        page = str(uuid.uuid4())
                        response = client.put('/api/blank-pdfs/' + page,
                                              json={'title': 'Embedded notebook', 'page_count': 2})
                        assert response.status_code == 200, response.text
                        block = response.json()
                        doc = block['properties']['doc_id']
                        note = str(uuid.uuid4())
                        response = client.post(f'/api/pages/{page}/ops', json={
                            'client': 'embed-test', 'ops': [{'op': 'insert', 'id': note, 'parent': page,
                            'position': 'a0', 'content': 'Portable quasarfox searchable notes', 'props': {}}]})
                        assert response.status_code == 200, response.text
                        state = {'account': result.account, 'workspace': result.workspace,
                                 'page': page, 'doc': doc, 'source': block['properties']['source_url']}
                        state_file.write_text(json.dumps(state))
                    state = json.loads(state_file.read_text())
                    assert state['account'] == result.account and state['workspace'] == result.workspace
                    pdf = client.get(state['source'])
                    assert pdf.status_code == 200 and pdf.content.startswith(b'%PDF-')
                    info = client.get('/api/pdf-info/' + state['doc'])
                    assert info.status_code == 200, info.text
                    tree = client.get('/api/blocks/' + state['page'] + '/subtree')
                    assert tree.status_code == 200 and 'quasarfox' in tree.text
                    search = client.get('/api/search', params={'q': 'quasarfox'})
                    assert search.status_code == 200 and 'quasarfox' in search.text, search.text
                    ws_url = result.url.replace('http:', 'ws:') + '/api/ws/page/' + state['page']
                    # Both credentials are necessary; Origin is validated BEFORE backend auth.
                    for bad_cookie, origin in ((result.session_cookie.header(), None),
                                                (cookie, 'https://attacker.example'),
                                                (result.capability_cookie.header(), None)):
                        try:
                            with connect(ws_url, additional_headers={'Cookie': bad_cookie}, origin=origin,
                                         open_timeout=5, proxy=None):
                                raise AssertionError('Unauthorized websocket accepted')
                        except InvalidStatus as error:
                            assert error.response.status_code == 403
                    for origin in (None, result.url):
                        with connect(ws_url, additional_headers={'Cookie': cookie}, origin=origin,
                                     open_timeout=5, proxy=None) as ws:
                            message = json.loads(ws.recv(timeout=5))
                            assert isinstance(message, dict)
                    # Credentials are never served back via bootstrap API or embedded in static.
                    for response in (client.get('/'), client.get('/api/session'), client.get('/api/health')):
                        assert result.capability not in response.text
                        assert result.session_cookie.value not in response.text
            finally:
                stopped.set()
                thread.join(timeout=25)
            assert not thread.is_alive(), 'worker did not shut down'
            assert not errors, errors
            port = int(result.url.rsplit(':', 1)[1])
            with socket.socket() as sock:
                assert sock.connect_ex(('127.0.0.1', port)) != 0
            with sqlite3.connect(data / 'users.db') as db:
                assert db.execute('SELECT count(*) FROM sessions WHERE token=?',
                                  (result.session_cookie.value,)).fetchone()[0] == 0
                accounts = db.execute('SELECT username,password_hash FROM users WHERE is_guest=0').fetchall()
                assert len(accounts) == 1 and accounts[0][0] == result.account
                assert accounts[0][1].startswith('$2')
            previous = result
        for secret in secrets_seen:
            assert secret not in output.getvalue(), 'credential leaked to output'
        marker = (data / '.gamma-ios-identity.json').read_text()
        assert set(json.loads(marker)) == {'account'}
    print('real embedded runtime checks passed: ' + phase)


class EmbeddedRuntimeTests(unittest.TestCase):
    def test_full_backend_worker_security_restart(self):
        with tempfile.TemporaryDirectory(prefix='gamma-embedded-test-') as temp:
            root = Path(temp)
            static = root / 'dist'
            (static / 'assets').mkdir(parents=True)
            (static / 'index.html').write_text('<!doctype html><title>bundled fixture</title>')
            (static / 'assets' / 'probe.txt').write_text('bundled-static')
            for phase in ('first', 'restart'):
                proc = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--child',
                                       str(root / 'private-data'), str(static), phase],
                                      capture_output=True, text=True, timeout=120)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                self.assertIn('checks passed', proc.stdout)

    def test_rejects_missing_bundle_without_importing_gamma(self):
        import gamma_ios_runtime as runtime
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):
                runtime.serve(runtime.RuntimeConfig(Path(temp) / 'data', Path(temp) / 'missing'),
                              lambda _: self.fail('unexpected readiness'), threading.Event())
        self.assertNotIn('gamma.config', sys.modules)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--child':
        exercise(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4])
    else:
        unittest.main()
