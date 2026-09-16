"""Export the curated demo through the API, without reading account databases."""
import argparse
import getpass
import http.cookiejar
import json
import os
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base', default='http://127.0.0.1:9001')
parser.add_argument('--username', default='demo')
parser.add_argument('--out', type=Path, default=ROOT / 'tmp/readme-media/demo.zip')
args = parser.parse_args()
base = args.base.rstrip('/')
password = os.environ.get('DEMO_PASSWORD') or getpass.getpass('Demo password: ')
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
with opener.open(urllib.request.Request(base + '/api/login',
        data=json.dumps({'username': args.username, 'password': password}).encode(),
        headers={'Content-Type': 'application/json'}), timeout=30) as response:
    response.read()
with opener.open(base + '/api/session', timeout=30) as response:
    workspace = json.load(response)['default_workspace']
with opener.open(urllib.request.Request(base + '/api/export',
        headers={'X-Gamma-Workspace': workspace}), timeout=120) as response:
    data = response.read()
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_bytes(data)
print(f'Exported curated workspace to {args.out} ({len(data)} bytes)')
