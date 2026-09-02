#!/usr/bin/env bash
# Run .github/workflows/desktop-release.yml's job locally, in the same order,
# with the same commands.
#
#   desktop/scripts/ci-local.sh              # this working tree
#   desktop/scripts/ci-local.sh --clone      # a clean clone of HEAD (what CI sees)
#   desktop/scripts/ci-local.sh --container  # …and the tests on a bare ubuntu:24.04
#
# `--clone` is the one that matters before tagging a release: it uses committed
# state only and a fresh `npm ci`, which is how a lockfile out of sync with
# package.json gets caught here instead of on a runner.
#
# The only steps not reproduced are the ones that need GitHub: checkout,
# setup-node, the cache, artifact upload, the release, and — on a Linux box —
# the macOS-only ad-hoc signing. Packaging uses `--dir` (no dmg/AppImage);
# what the tests need is the unpacked app, and the installer formats add
# minutes without adding coverage.

set -euo pipefail

cd "$(dirname "$0")/.."
DESKTOP_DIR="$PWD"
REPO_DIR="$(cd .. && pwd)"
ARCH="$(node -p 'process.arch')"
CLEAN_CLONE=false
IN_CONTAINER=false
WORK=""

for arg in "$@"; do
  case "$arg" in
    --clone) CLEAN_CLONE=true ;;
    --container) IN_CONTAINER=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m=== %s\033[0m\n' "$1"; }

cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    echo "(leaving $WORK in place for inspection; rm -rf it when done)"
  fi
}
trap cleanup EXIT

if $CLEAN_CLONE; then
  step "Clone HEAD into a scratch directory"
  WORK="$(mktemp -d)"
  git -C "$REPO_DIR" clone --quiet --no-hardlinks --depth 1 \
    "file://$REPO_DIR" "$WORK/repo"
  echo "cloned $(git -C "$WORK/repo" log --oneline -1)"
  # Uncommitted work is invisible to CI; say so rather than let it confuse.
  if ! git -C "$REPO_DIR" diff --quiet HEAD -- . ; then
    echo "note: this working tree has uncommitted changes, which this run ignores"
  fi
  REPO_DIR="$WORK/repo"
  DESKTOP_DIR="$REPO_DIR/desktop"
fi

step "Build the frontend"
cd "$REPO_DIR/frontend"
npm ci --no-audit --no-fund
npm run build

step "Install the shell's dependencies"
cd "$DESKTOP_DIR"
npm ci --no-audit --no-fund

step "Lint the shell"
npm run lint

step "Shell unit tests"
npm run test:unit

step "Stage the Python runtime"
npm run stage -- --arch "$ARCH"

step "Package"
npx electron-builder --dir "--$ARCH"

step "Locate the built app"
# Check the architecture of what we found. `find | head -1` once handed CI's
# x86-64 job an arm64 binary — dist/linux-arm64-unpacked sorts first — and
# every test failed instantly with "process failed to launch".
case "$ARCH" in
  x64)   WANT="x86.64|x86_64" ;;
  arm64) WANT="aarch64|arm64" ;;
  *)     echo "unhandled arch $ARCH" >&2; exit 1 ;;
esac
APP=""
if [ "$(uname)" = "Darwin" ]; then
  for bundle in $(find dist -maxdepth 2 -name "Gamma.app" -type d); do
    if file "$bundle/Contents/MacOS/Gamma" | grep -qE "$WANT"; then
      APP="$bundle/Contents/MacOS/Gamma"
      break
    fi
  done
  [ -n "$APP" ] || { echo "no $ARCH Gamma.app under dist/"; ls -R dist | head -50; exit 1; }
  # electron-builder signs the bundle during packaging (scripts/afterPack.cjs);
  # verify rather than re-sign, so this matches what CI ships.
  codesign --verify --deep --strict --verbose=2 "$(dirname "$(dirname "$APP")")"
else
  for exe in $(find dist -maxdepth 2 -name "gamma-desktop" -type f); do
    if file "$exe" | grep -qE "$WANT"; then APP="$exe"; break; fi
  done
  [ -n "$APP" ] || { echo "no $ARCH gamma-desktop under dist/"; ls -R dist | head -50; exit 1; }
fi
file "$APP"

step "Run the packaged app's tests"
export GAMMA_PACKAGED_APP="$APP"
scripts/run-packaged-tests.sh

# A dev box has years of accumulated libraries; a fresh runner has none. This
# is how the 0.1.0 Linux job's failure was found — Electron could not even load
# (19 unresolved sonames) on a clean Ubuntu.
if $IN_CONTAINER; then
  step "Run the packaged app's tests on a bare ubuntu:24.04"
  if [ "$(uname)" != "Linux" ]; then
    echo "skipped: --container needs a Linux host (the image must match the build)"
  else
    docker run --rm \
      -v "$REPO_DIR:/repo" \
      -v "$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")/bin:/hostnode/bin:ro" \
      -w /repo/desktop ubuntu:24.04 bash -euc '
        export DEBIAN_FRONTEND=noninteractive PATH=/hostnode/bin:$PATH
        apt-get update -qq >/dev/null
        apt-get install -y -qq ca-certificates xvfb >/dev/null 2>&1
        node node_modules/playwright/cli.js install-deps chromium >/dev/null 2>&1
        apt-get install -y -qq libgtk-3-0t64 >/dev/null 2>&1 \
          || apt-get install -y -qq libgtk-3-0 >/dev/null 2>&1
        app=$(find dist -maxdepth 2 -name gamma-desktop -type f | head -1)
        ldd "$app" | grep "not found" && exit 1 || echo "all libraries resolve"
        GAMMA_PACKAGED_APP="$app" scripts/run-packaged-tests.sh
      '
  fi
fi

printf '\n\033[1mall steps passed\033[0m (%s, %s)\n' "$(uname)" "$ARCH"
