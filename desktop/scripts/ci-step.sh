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
    # \r → \n first: a progress meter is a single line thousands of
    # characters long, and tail(1) would count it as one while it consumed the
    # whole annotation. Blank lines go too, for the same reason.
    tr '\r' '\n' < "$out" | awk 'NF' | tail -60
  } > "$out.diag"
  # An annotation message is a single line: %-escape first, then newlines.
  # sed and awk rather than python3, which Git Bash on the Windows runners
  # does not reliably provide.
  message=$(sed -e 's/%/%25/g' -e 's/\r$//' "$out.diag" | awk '{printf "%s%%0A", $0}')
  echo "::error title=$title::${message:0:8000}"
  rm -f "$out.diag"
fi

exit "$status"
