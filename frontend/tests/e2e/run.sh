#!/usr/bin/env bash
# Run the Playwright smoke test against an isolated backend instance on :9002
# (throwaway data dir, known admin credentials, built frontend served as SPA).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # frontend/
REPO="$(cd "$ROOT/.." && pwd)"                 # repo root
PORT="${PORT:-9002}"
DATA_DIR="$(mktemp -d /tmp/gamma-smoke.XXXXXX)"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-smoke-pass-123}"
VENV="$REPO/backend/venv"

BACKEND_PID=""
cleanup() {
  if [[ -n "$BACKEND_PID" ]]; then kill "$BACKEND_PID" 2>/dev/null || true; wait "$BACKEND_PID" 2>/dev/null || true; fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

echo "[smoke] building frontend…"
(cd "$ROOT" && npm run build >/dev/null)

echo "[smoke] generating test PDF…"
python3 "$ROOT/tests/e2e/make_test_pdf.py" "$DATA_DIR/test.pdf" >/dev/null

echo "[smoke] starting backend on :$PORT (user=$ADMIN_USER)…"
# Refuse to run if something already answers on the port (a stale instance from
# an earlier aborted run would otherwise hijack the smoke test's traffic).
if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "port $PORT already in use — a stale backend instance is running"; exit 1;
fi
# `exec` makes uvicorn replace the subshell so $! is uvicorn's own PID and the
# cleanup trap can kill it (a non-exec'd child would orphan on teardown).
(
  cd "$REPO/backend"
  exec env PYTHONUNBUFFERED=1 \
    GAMMA_DATA_DIR="$DATA_DIR" \
    GAMMA_STATIC_DIR="$ROOT/dist" \
    GAMMA_ADMIN_USER="$ADMIN_USER" \
    GAMMA_ADMIN_PASSWORD="$ADMIN_PASS" \
    "$VENV/bin/uvicorn" app:app --host 127.0.0.1 --port "$PORT"
) >"$DATA_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

echo "[smoke] waiting for health…"
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || {
  echo "backend failed to start:"; cat "$DATA_DIR/backend.log"; exit 1;
}

echo "[smoke] seeding a PDF via API…"
LOGIN_RESP="$(curl -s -c "$DATA_DIR/cookies.txt" -X POST "http://127.0.0.1:$PORT/api/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}")"
echo "  login: $LOGIN_RESP"
if [[ "$LOGIN_RESP" != *'"ok":true'* ]]; then
  echo "--- backend.log ---"; cat "$DATA_DIR/backend.log"; exit 1;
fi
UPLOAD_RESP="$(curl -s -b "$DATA_DIR/cookies.txt" -X POST "http://127.0.0.1:$PORT/api/uploads" \
  -F "file=@$DATA_DIR/test.pdf;type=application/pdf")"
echo "  upload: $UPLOAD_RESP"
SOURCE_URL="$(echo "$UPLOAD_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin)["source_url"])')"
DOC_ID="$(echo "$UPLOAD_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin)["doc_id"])')"
BLOCK_ID="$(curl -s -b "$DATA_DIR/cookies.txt" -X POST "http://127.0.0.1:$PORT/api/blocks/by-doc/$DOC_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"default_title\":\"Smoke Test Paper\",\"source_url\":\"$SOURCE_URL\"}" \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])')"
echo "[smoke] source_url=$SOURCE_URL block_id=$BLOCK_ID"

echo "[smoke] running Playwright…"
cd "$ROOT"
BASE_URL="http://127.0.0.1:$PORT" \
  ADMIN_USER="$ADMIN_USER" \
  ADMIN_PASS="$ADMIN_PASS" \
  SOURCE_URL="$SOURCE_URL" \
  BLOCK_ID="$BLOCK_ID" \
  npx playwright test tests/e2e/smoke.spec.js "$@"
