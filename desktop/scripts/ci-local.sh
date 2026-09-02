#!/usr/bin/env bash
# Run .github/workflows/desktop-release.yml's job locally, in the same order,
# with the same commands.
#
#   desktop/scripts/ci-local.sh            # this working tree
#   desktop/scripts/ci-local.sh --clone    # a clean clone of HEAD (what CI sees)
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
WORK=""

for arg in "$@"; do
  case "$arg" in
    --clone) CLEAN_CLONE=true ;;
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
if [ "$(uname)" = "Darwin" ]; then
  BUNDLE="$(find dist -maxdepth 2 -name "Gamma.app" -type d | head -1)"
  [ -n "$BUNDLE" ] || { echo "no Gamma.app under dist/"; ls -R dist | head -50; exit 1; }
  APP="$BUNDLE/Contents/MacOS/Gamma"
  step "Ad-hoc sign"
  codesign --force --deep --sign - "$BUNDLE"
  codesign --verify --deep --verbose=2 "$BUNDLE"
else
  APP="$(find dist -maxdepth 2 -name "gamma-desktop" -type f | head -1)"
  [ -n "$APP" ] || { echo "no gamma-desktop under dist/"; ls -R dist | head -50; exit 1; }
fi
echo "$APP"

step "Run the packaged app's tests"
export GAMMA_PACKAGED_APP="$APP"
if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ]; then
  xvfb-run -a node --test --test-concurrency=1 test/smoke.mjs
else
  node --test --test-concurrency=1 test/smoke.mjs
fi

printf '\n\033[1mall steps passed\033[0m (%s, %s)\n' "$(uname)" "$ARCH"
