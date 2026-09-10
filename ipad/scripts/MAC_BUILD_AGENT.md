# Desktop-session build agent

The Mac-specific `com.gamma.ipad.agent-build.plist` registers a manual LaunchAgent in the logged-in user's `gui/<uid>` domain. It runs `mac-agent-build.sh`, using the existing generated project's signing configuration. It neither stores passwords nor changes keychain ACLs. The checked-in plist is a template: run `python3 ipad/scripts/install-mac-build-agent.py` from the repository root on your Mac to substitute this checkout's paths and register it. Do not bootstrap the unexpanded template directly. The script builds for `generic/platform=iOS` so an existing signing profile can produce an app even while the iPad is disconnected. Actual installation still requires the registered device to be reachable.

Trigger from SSH:

```sh
launchctl kickstart gui/$(id -u)/com.gamma.ipad.agent-build
```

Do not use `-k` to restart a running build. Check `launchctl print gui/$(id -u)/com.gamma.ipad.agent-build` first. The build result is written to `<checkout>/gui-build/status`; logs are stdout.log/stderr.log in that directory. Successful app output is `<checkout>/GUIBuildDerivedData/Build/Products/Debug-iphoneos/GammaIPad.app`.

The job is not scheduled, has no KeepAlive and does not run at login. A logged-in desktop session and usable development signing key are required. This is not a promise to bypass locked keychains, authorization prompts or signing expiry.

Remove registration without deleting source/build outputs:

```sh
launchctl bootout gui/$(id -u)/com.gamma.ipad.agent-build
```

Then remove the corresponding plist in `~/Library/LaunchAgents` if no longer wanted.
