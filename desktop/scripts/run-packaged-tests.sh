#!/usr/bin/env bash
# Run the Electron suite against a packaged build, and on failure report what
# happened as a GitHub *annotation*.
#
#   GAMMA_PACKAGED_APP=dist/linux-unpacked/gamma-desktop scripts/run-packaged-tests.sh
#
# Why annotations: downloading a workflow's logs needs admin rights on the
# repository, and so does reading a draft release's assets. Annotations are
# public. A job that cannot explain its own failure to whoever is fixing it
# turns every CI red into a guessing game, and guessing is expensive here —
# each attempt costs a tag and a runner.

set -uo pipefail

cd "$(dirname "$0")/.."
: "${GAMMA_PACKAGED_APP:?set GAMMA_PACKAGED_APP to the packaged binary}"

out="$(mktemp)"
trap 'rm -f "$out"' EXIT

if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ]; then
  xvfb-run -a node --test --test-concurrency=1 test/smoke.mjs 2>&1 | tee "$out"
else
  node --test --test-concurrency=1 test/smoke.mjs 2>&1 | tee "$out"
fi
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ] && [ -n "${GITHUB_ACTIONS:-}" ]; then
  {
    echo "app:  $GAMMA_PACKAGED_APP"
    echo "host: $(uname -srm)"
    echo "node: $(node --version)"
    if [ "$(uname)" = "Linux" ]; then
      echo "unresolved libraries: $(ldd "$GAMMA_PACKAGED_APP" 2>&1 | grep -c 'not found')"
      echo "xvfb: $(command -v xvfb-run || echo missing)"
    fi
    echo "--- last 60 lines ---"
    tail -60 "$out"
  } > "$out.diag"

  # Annotation messages are one line: %-escape first, then newlines.
  python3 - "$out.diag" <<'PY'
import sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
esc = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
print(f"::error title=packaged tests failed::{esc[:8000]}")
PY
  rm -f "$out.diag"
fi

exit "$status"
