# iPad acceptance and verification

## Recorded results

The latest recorded simulator regression reported **179 passed, 6 skipped,
0 failed**. Skips are opt-in checks, not passes. This is historical evidence,
not a claim that every checkout or device has been tested. Some historical
probes used private inputs; those inputs and machine-specific reports are not
published and are not required for the portable suite.

Earlier isolated-backend acceptance passed all four enabled native integration
tests: ink/notes reopen, AAC outbox upload, offline audio preparation, and
non-default-workspace isolation. Cache tests cover identity validation,
interrupted migration, rollback/refusal, reopen, and retention of pending work.
Session tests cover restoration, access changes, cancellation and reconnection.
Source-contract checks complement, but cannot replace, Apple framework tests.

## Reproduce on your own environment

1. Follow [README.md](README.md) to install Xcode/XcodeGen and generate the project.
2. Select an available iPad simulator in Xcode and run the GammaIPad test scheme.
   For command-line execution, from `ipad/`:

   ```sh
   xcodebuild -project GammaIPad.xcodeproj -scheme GammaIPad \
     -destination 'platform=iOS Simulator,name=YOUR_SIMULATOR_NAME' \
     CODE_SIGNING_ALLOWED=NO test
   ```

3. Run portable structural checks from the repository root:

   ```sh
   python3 ipad/scripts/test_native_workspace_contract.py
   python3 ipad/scripts/test_coordinate_fixture.py
   ```

4. Enable live-backend checks only against a disposable test instance; follow
   [scripts/LIVE_TEST.md](scripts/LIVE_TEST.md). Never use production credentials
   or private user data as repository fixtures.
5. The deployment WebKit smoke test additionally requires the compile condition
   `GAMMA_DEPLOYMENT_SMOKE` and an explicit `GAMMA_DEPLOYMENT_URL` HTTPS server
   origin in the **test process environment**. Without a valid URL it skips.
   This is an unauthenticated page/bridge check, not native API acceptance.

Keep logs, result bundles, screenshots, signing overrides and private inputs
local. Record suite version, enabled conditions, pass/skip/failure counts and
remaining boundaries when repeating acceptance.

## Remaining acceptance boundaries

Simulator and synthetic-audio tests do not guarantee physical Pencil fidelity,
palm rejection, pressure/latency, microphone quality, interruptions, thermal
behavior, or long-session performance. Separately verify flight-mode relaunch,
real-network download interruption, non-default-workspace Web/native handoff,
and migration using an authorized device-data copy. Installation/launch alone
is not hardware acceptance. Atomic-write and simulated-crash tests are not a
guarantee against power loss or storage failure.

See [NATIVE_INTEGRATION.md](NATIVE_INTEGRATION.md), [OFFLINE.md](OFFLINE.md),
[NOTE_REPLAY.md](NOTE_REPLAY.md), and the
[integration acceptance checklist](../docs/design/native-integration-acceptance.md)
for behavior and acceptance scope.
