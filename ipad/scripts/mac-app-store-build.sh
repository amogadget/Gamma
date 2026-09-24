#!/bin/bash
# Use an App Store Connect API key for CI/SSH, or a GUI account as a fallback.
# Usage: mac-app-store-build.sh ROOT TEAM_ID [archive|upload] [BUILD_NUMBER]
# Upload delivers a build to App Store Connect; it does not submit for review.
set -euo pipefail
ROOT="${1:?release workspace root required}"
TEAM="${2:?Apple developer team ID required}"
MODE="${3:-archive}"
BUILD="${4:-${GAMMA_BUILD_NUMBER:-}}"
BUILD_ARGS=("DEVELOPMENT_TEAM=$TEAM" PRODUCT_BUNDLE_IDENTIFIER=net.blitzbuild.gamma)
if [[ -n "${GAMMA_MARKETING_VERSION:-}" ]]; then BUILD_ARGS+=("MARKETING_VERSION=$GAMMA_MARKETING_VERSION"); fi
if [[ -n "$BUILD" ]]; then BUILD_ARGS+=("CURRENT_PROJECT_VERSION=$BUILD"); fi
OUT="$ROOT/appstore-build"
ARCHIVE_PATH="${GAMMA_ARCHIVE_PATH:-$OUT/GammaIPad.xcarchive}"
# CI/SSH can authenticate directly; no GUI Apple ID session is required.
# The private key stays outside the checkout and is never printed or copied.
AUTH_ARGS=(-allowProvisioningUpdates)
if [[ -n "${GAMMA_ASC_KEY_PATH:-}" || -n "${GAMMA_ASC_KEY_ID:-}" || -n "${GAMMA_ASC_ISSUER_ID:-}" ]]; then
  : "${GAMMA_ASC_KEY_PATH:?App Store Connect private-key file path required}"
  : "${GAMMA_ASC_KEY_ID:?App Store Connect key ID required}"
  : "${GAMMA_ASC_ISSUER_ID:?App Store Connect issuer ID required}"
  if [[ ! -r "$GAMMA_ASC_KEY_PATH" ]]; then
    printf 'App Store Connect private-key file is not readable.\n' >&2
    exit 2
  fi
  AUTH_ARGS+=(-authenticationKeyPath "$GAMMA_ASC_KEY_PATH"
    -authenticationKeyID "$GAMMA_ASC_KEY_ID"
    -authenticationKeyIssuerID "$GAMMA_ASC_ISSUER_ID")
fi
mkdir -p "$OUT"
finish() { local result=$?; printf 'exit_code=%s\n' "$result" > "$OUT/status"; }
trap finish EXIT
printf 'running mode=%s\n' "$MODE" > "$OUT/status"
case "$MODE" in
  archive)
    /usr/bin/xcodebuild -quiet \
      -project "$ROOT/ipad/GammaIPad.xcodeproj" -scheme GammaIPad \
      -configuration Release -destination 'generic/platform=iOS' \
      -derivedDataPath "$ROOT/AppStoreDerivedData" \
      -archivePath "$ARCHIVE_PATH" \
      "${AUTH_ARGS[@]}" \
      "${BUILD_ARGS[@]}" archive
    ;;
  upload)
    test -d "$ARCHIVE_PATH"
    IDENTIFIER="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleIdentifier' "$ARCHIVE_PATH/Info.plist")"
    test "$IDENTIFIER" = net.blitzbuild.gamma
    /usr/bin/codesign --verify --deep --strict "$ARCHIVE_PATH/Products/Applications/GammaIPad.app"
    /usr/bin/python3 - "$ROOT" "$TEAM" <<'PY'
import pathlib, plistlib, sys
root = pathlib.Path(sys.argv[1])
options = plistlib.loads((root / 'ipad/ExportOptions.appstore.plist').read_bytes())
options['teamID'] = sys.argv[2]
(root / 'ExportOptions.plist').write_bytes(plistlib.dumps(options))
PY
    /usr/bin/xcodebuild -quiet -exportArchive \
      -archivePath "$ARCHIVE_PATH" \
      -exportPath "$OUT/upload" -exportOptionsPlist "$ROOT/ExportOptions.plist" \
      "${AUTH_ARGS[@]}"
    ;;
  *) printf 'Unknown mode: %s\n' "$MODE" >&2; exit 2 ;;
esac
