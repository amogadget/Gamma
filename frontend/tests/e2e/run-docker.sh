#!/usr/bin/env bash
# Run the smoke test against the PUBLISHED image (ghcr.io/tim4431/gamma:latest)
# for behavior parity vs the current source. Isolated port :9003 + throwaway
# data volume; same seeding + assertions as run.sh, so a green run here means
# the published frontend behaves like the working tree.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # frontend/
REPO="$(cd "$ROOT/.." && pwd)"                 # repo root
PORT="${PORT:-9003}"
DATA_DIR="$(mktemp -d /tmp/gamma-docker.XXXXXX)"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-smoke-pass-123}"
IMAGE="${IMAGE:-ghcr.io/tim4431/gamma:latest}"
VENV="$REPO/backend/venv"

CONTAINER=""
cleanup() {
  if [[ -n "$CONTAINER" ]]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

echo "[docker] running $IMAGE on :$PORT…"
CONTAINER="$(docker run -d --rm -p "127.0.0.1:$PORT:9001" \
  -e GAMMA_ADMIN_USER="$ADMIN_USER" -e GAMMA_ADMIN_PASSWORD="$ADMIN_PASS" \
  -v "$DATA_DIR:/data" "$IMAGE")"

echo "[docker] waiting for health…"
for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || {
  echo "container failed:"; docker logs "$CONTAINER"; exit 1;
}

echo "[docker] seeding…"
LOGIN_RESP="$(curl -s -c "$DATA_DIR/cookies.txt" -X POST "http://127.0.0.1:$PORT/api/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}")"
echo "  login: $LOGIN_RESP"
if [[ "$LOGIN_RESP" != *'"ok":true'* ]]; then
  echo "--- container log ---"; docker logs "$CONTAINER"; exit 1;
fi
python3 "$ROOT/tests/e2e/make_test_pdf.py" "$DATA_DIR/a.pdf" 4 >/dev/null
python3 "$ROOT/tests/e2e/make_test_pdf.py" "$DATA_DIR/b.pdf" 5 >/dev/null
seed_pdf() {
  local up doc src
  up="$(curl -s -b "$DATA_DIR/cookies.txt" -X POST "http://127.0.0.1:$PORT/api/uploads" -F "file=@$1;type=application/pdf")"
  doc="$(echo "$up" | python3 -c 'import sys, json; print(json.load(sys.stdin)["doc_id"])')"
  src="$(echo "$up" | python3 -c 'import sys, json; print(json.load(sys.stdin)["source_url"])')"
  curl -s -b "$DATA_DIR/cookies.txt" -X POST "http://127.0.0.1:$PORT/api/blocks/by-doc/$doc" \
    -H 'Content-Type: application/json' \
    -d "{\"default_title\":\"$2\",\"source_url\":\"$src\"}" \
    | python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])'
}
BLOCK_A="$(seed_pdf "$DATA_DIR/a.pdf" "Paper A")"
BLOCK_B="$(seed_pdf "$DATA_DIR/b.pdf" "Paper B")"
NOTES_BLOCK="$(BASE_URL="http://127.0.0.1:$PORT" ADMIN_USER="$ADMIN_USER" ADMIN_PASS="$ADMIN_PASS" "$VENV/bin/python" "$ROOT/tests/e2e/seed_notes.py")"
echo "[docker] block_a=$BLOCK_A block_b=$BLOCK_B notes_block=$NOTES_BLOCK"

echo "[docker] running Playwright…"
cd "$ROOT"
BASE_URL="http://127.0.0.1:$PORT" \
  ADMIN_USER="$ADMIN_USER" \
  ADMIN_PASS="$ADMIN_PASS" \
  BLOCK_A="$BLOCK_A" \
  BLOCK_B="$BLOCK_B" \
  NOTES_BLOCK="$NOTES_BLOCK" \
  npx playwright test tests/e2e/smoke.spec.js "$@"
