#!/bin/bash
# Triggered by a GUI-session LaunchAgent, never by a timer. No secrets in script.
set -u
# Resolve the checkout from this script, not a particular user's home path.
ROOT="$(dirname "$(dirname "$(dirname "$0")")")"
mkdir -p "$ROOT/gui-build"
STATUS="$ROOT/gui-build/status"
printf 'running\n' > "$STATUS.tmp"
mv "$STATUS.tmp" "$STATUS"
/usr/bin/xcodebuild -quiet \
  -project "$ROOT/ipad/GammaIPad.xcodeproj" \
  -scheme GammaIPad \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$ROOT/GUIBuildDerivedData" \
  -allowProvisioningUpdates build
result=$?
printf 'exit_code=%s\n' "$result" > "$STATUS.tmp"
mv "$STATUS.tmp" "$STATUS"
exit "$result"
