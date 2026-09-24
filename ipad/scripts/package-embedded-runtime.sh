#!/bin/sh
# Xcode build phase: no installs, downloads, or interpreter discovery via pip.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${GAMMA_BUILD_PYTHON:-python3}" "$SCRIPT_DIR/package-embedded-runtime.py" "$@"
