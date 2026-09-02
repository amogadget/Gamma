#!/usr/bin/env bash
# Run the Electron suite against a packaged build, with enough context in the
# failure annotation to diagnose it without the workflow log (see ci-step.sh
# for why that matters).
#
#   GAMMA_PACKAGED_APP=dist/linux-unpacked/gamma-desktop scripts/run-packaged-tests.sh

set -uo pipefail

cd "$(dirname "$0")/.."
: "${GAMMA_PACKAGED_APP:?set GAMMA_PACKAGED_APP to the packaged binary}"

prefix=""
if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ]; then
  prefix="xvfb-run -a "
fi

diag="app:  $GAMMA_PACKAGED_APP
host: $(uname -srm)
node: $(node --version)"
if [ "$(uname)" = "Linux" ]; then
  diag="$diag
unresolved libraries: $(ldd "$GAMMA_PACKAGED_APP" 2>&1 | grep -c 'not found')
xvfb: $(command -v xvfb-run || echo missing)
DISPLAY: ${DISPLAY:-unset}"
fi

CI_STEP_DIAG="$diag" exec scripts/ci-step.sh "packaged tests" \
  "${prefix}node --test --test-concurrency=1 test/smoke.mjs"
