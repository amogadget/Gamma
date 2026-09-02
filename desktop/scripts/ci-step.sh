#!/usr/bin/env bash
# Run one CI step and, if it fails, emit its output as a GitHub annotation.
#
#   scripts/ci-step.sh "<title>" "<shell command>"
#
# Downloading a workflow's logs requires admin rights on the repository;
# annotations are public. Without this, a failure that only reproduces on a
# runner costs a tag and a full build per guess — so every step that can
# plausibly fail goes through here, not just the interesting ones.
#
# Extra context can be passed in CI_STEP_DIAG and is printed above the tail.

set -uo pipefail

title="${1:?usage: ci-step.sh <title> <command>}"
command="${2:?usage: ci-step.sh <title> <command>}"

out="$(mktemp)"
trap 'rm -f "$out"' EXIT

bash -o pipefail -c "$command" 2>&1 | tee "$out"
status=${PIPESTATUS[0]}
[ "$status" -eq 0 ] && exit 0

if [ -n "${GITHUB_ACTIONS:-}" ]; then
  {
    [ -n "${CI_STEP_DIAG:-}" ] && printf '%s\n' "$CI_STEP_DIAG"
    echo "exit status: $status"
    echo "--- last 60 lines ---"
    tail -60 "$out"
  } > "$out.diag"
  # An annotation message is a single line: %-escape first, then newlines.
  TITLE="$title" python3 - "$out.diag" <<'PY'
import os, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
esc = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
print(f"::error title={os.environ['TITLE']}::{esc[:8000]}")
PY
  rm -f "$out.diag"
fi

exit "$status"
