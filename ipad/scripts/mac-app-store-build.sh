#!/bin/bash
# Run in the logged-in macOS GUI session so Xcode can use its signed-in account.
# Usage: mac-app-store-build.sh ROOT TEAM_ID [archive|upload] [BUILD_NUMBER]
# Upload delivers a build to App Store Connect; it does not submit for review.
set -euo pipefail
ROOT="${1:?release workspace root required}"
TEAM="${2:?Apple developer team ID required}"
MODE="${3:-archive}"
BUILD="${4:-1}"
OUT="$ROOT/appstore-build"
ARCHIVE_PATH="${GAMMA_ARCHIVE_PATH:-$OUT/GammaIPad.xcarchive}"
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
      -allowProvisioningUpdates \
      DEVELOPMENT_TEAM="$TEAM" PRODUCT_BUNDLE_IDENTIFIER=net.blitzbuild.gamma \
      MARKETING_VERSION=1.0 CURRENT_PROJECT_VERSION="$BUILD" archive
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
      -allowProvisioningUpdates
    ;;
  *) printf 'Unknown mode: %s\n' "$MODE" >&2; exit 2 ;;
esac
