#!/usr/bin/env bash
set -euo pipefail
cd /home/ubuntu/pdf-share/frontend
exec /usr/bin/python3 -m http.server 4173 --bind 127.0.0.1 -d dist
