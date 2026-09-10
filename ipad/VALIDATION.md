# Remote Mac validation

## Environment

- Source branch: `ipad-app`. Earlier entries describe pre-commit development snapshots; consult Git history for the published source revision.
- SSH host alias: `mymac`; dedicated workspace: `~/gamma-ipad-agent/ipad`.
- macOS 26.6.2; Xcode 26.6 (17F113); XcodeGen 2.46.0.
- Simulator: iPad Pro 11-inch (M5), iOS 26.5.
- Physical iPad: iPad Pro 11-inch (2nd generation), iPadOS 26.6.1; wired, paired, developer mode enabled.

## Branding and first source publication preparation

Login now uses the existing `desktop/assets/icon.png` through GammaMark; the AppIcon catalog is derived from the same artwork with an opaque app-icon background. `GammaBrandingTests` verified image loading and the compiled primary icon name, and the login screenshot was inspected (`artifacts/login-gamma-brand.png`).

`BrandingCommit-1.xcresult`: full standard iPad suite **75 passed, 2 opt-in live tests skipped, zero failures**. The corresponding backend suite had **483 passing tests**; Web tests **48 passed** and production build succeeded. The signed device app's primary icon was verified as AppIcon, then installed/launched on the physical iPad, installation sequence 1764.

Deployment README covers matching server/TLS, Xcode/Personal Team setup, ignored local signing overrides, device install and a portable desktop-session build-agent installer. The installer was exercised on the Mac without changing keychain permissions or storing credentials. `project.local.yml`, generated projects, derived data and agent logs remain ignored. Follow-up feature parity and Web Replay work is documented in `ROADMAP.md`, not claimed implemented by this branding change.

## Phase 5A Note Replay integrated

See `NOTE_REPLAY.md`. New recordings capture segment-relative Pencil/page/note timing, persist it atomically with the page outbox, and sync it in the audio block. The inline player supports progressive final-surviving-ink replay, cross-page timeline scrubbing, play/pause, ±10 seconds and tapping visible timed ink to seek. Older untimed recordings explicitly remain audio with static notes. Replay uses a separate read-only canvas; no exact erased-stroke/undo history is claimed.

Verified Mac result bundles: `ReplayLive-1.xcresult` (15 passed including real backend replay-event round-trip), `ReplayRetry-1.xcresult` (12 passed including failed-save timing/merge protection). Backend audio/ink tests: 19 passed, Ruff passed. Timeline schema deployed after a consistent backup; public OpenAPI and health verified. GUI-session signed build passed; installed and launched on physical iPad sequence 1756. Physical recording/Pencil interaction and long-session smoothness remain user acceptance checks. No iPad push or new release.

## Phase 3 recording integrated

Recording is now production app code, not just the research fixture. See `RECORDING.md`: native permission/AVAudioRecorder control, five-minute segments, pause/resume/stop, interruption/background recovery, atomic account-scoped metadata/outbox, audio block upload and sequential playback. Web audio controls and corresponding server API were deployed after backing up the existing data volume.

Verified: 18 backend audio/ink tests, 48 frontend tests and successful Web build; 10 initial native recording/workspace/codec tests, a real-backend AAC outbox test, and four final production recovery tests after fixing EOF handling. The final signed app was installed and launched on the physical iPad, sequence 1748. Microphone usage declaration and signature were verified. Hardware recording quality/interruptions/gaps remain unverified; no Phase 4 timestamps or replay added. No push or new release.

## Pencil-tap selection micro-adjustment

Added a Pencil-only tap recognizer on PDFView, using public PDFKit point conversion into canonical crop coordinates. A tap near an existing nonselected block's stroke selects that block, enables Pencil mode and follows its Notes selection. Current active ink retains normal writing priority; blank space and gaps between lines are not whole-note hit targets. Finger pan/pinch stays unchanged. PencilKit drawing waits for the selection recognizer to fail, protecting against a stray dot when changing annotations; old drawing is flushed before selection changes.

`PencilSelection-1.xcresult`: 11 targeted tests passed (4 hit-selection tests + 7 reader regressions), zero failures/skips. Coverage includes active/overlap priority, blank space, no mutation and persistence callbacks. Physical Pencil gesture timing/latency still requires user testing; this simulator run does not synthesize Pencil touches. No overall UI redesign or server/web release in this change.

The device-specific build failed because the iPad was unavailable. Changed the manual build agent destination to generic iOS; that build exited 0 and strict signature verification passed. Installation was attempted but CoreDevice returned error 1011 (device not found). The signed update is ready on the Mac but has not been installed. All changed files remain local under `ipad/` and were not pushed.

## Authenticated library redesign

Replaced the post-login system List with a Gamma web-style library: flat toolbar/search, actual recently viewed cards, server folder hierarchy with counts and navigation, compact file rows, folder labels, title/modified sorting and a functional list/grid switch. No mock entries or unsupported chat/navigation buttons appear in the runtime UI. Recent IDs are recorded only after opening real documents and persisted in the account-scoped cache; existing data/outbox is unchanged.

`LibraryUI-1.xcresult` passed the library screenshot/folder/recents tests plus workspace regressions (7 tests). Inspected both authenticated-UI fixtures at 1194×834 and 834×1194, saved as `artifacts/library-landscape.png` and `artifacts/library-portrait.png`. These screenshots use labeled test data, not the user's library; recents on a real account fill as documents are opened. Desktop LaunchAgent run 3 exited 0; signature verification passed; installed and launched on the physical iPad (installation sequence 1660).

This iteration changes the library, not the previous PDF reader layout. It does not establish subjective UI acceptance; review the installed post-login view rather than the login screen.

## Web PDF handwriting overlay follow-up

The user's screenshot confirmed successful remote sync: Notes displayed the saved preview after refresh, but PdfViewer only rendered highlights. Added a separate `pdf_ink` layer to each PDF page using the same block's preview and canonical bounds. Mapping runs through pdf.js viewport coordinates, including crop origins, quarter-turn rotations and zoom; other-page ink is excluded. Overlays are display-only and do not capture pointer input.

Verification: 46 frontend unit tests passed, build succeeded, ESLint had no errors (one existing unrelated App hook warning). `node tests/e2e/pdf-ink.mjs` passed in real Chromium with the actual PdfViewer/pdf.js and six-page cropped/rotated fixture, checking placement, rotated orientation, page isolation and zoom. The first harness run needed correction of Vite's CommonJS default import shape. Local Vite test server was stopped afterward.

Deployed updated `gamma:local` through the existing compose service, retaining rollback image `gamma:before-web-ink-overlay` and the same data volume. Refresh the already-open Web page to load the new bundle and server blocks. No realtime block subscription was added; no reupload of existing ink is needed. Web ink remains preview rendering, not PencilKit editing or flattened PDF export.

## User-feedback fixes: UI, highlights and HTTP 405

- Read only the app's configured server preference: `https://annotation.amogadgetlab.com`. Unauthenticated probes confirmed `/api/assets` POST and `/api/blocks/{id}/ink` PUT returned 405, and both routes were absent from public OpenAPI. This was an undeployed backend feature, not transient connectivity.
- Built the current Gamma image, retained rollback image `gamma:before-ipad-route-update`, paused the old container for a consistent volume backup (`/home/ubuntu/gamma-deployment-backups/before-ipad-routes-20260909T062250Z.tar.gz`), then recreated only the Gamma service with its existing data volume.
- Verified public health 200, container healthy, all asset/ink/native-note routes present in OpenAPI, and a valid unauthenticated asset upload request now returns **401**, not 405. No test notes or authenticated writes were made to the user's live account.
- Client distinguishes 405/501 as missing server capability and pauses automatic sync, preserving the outbox. Explicit Retry resumes after server upgrade.
- Added decoding of existing `highlight_id`, `quote`, `color`, `pdf_position`, normalized viewport rectangle overlays (display-only), page navigation fallback and matching quoted text in Notes. Highlights do not enter PencilKit saves.
- Reworked reader chrome/Notes to follow the web's compact toolbar, neutral paper/sidebar surfaces, colored annotation dots, quote bars, nested note rows and subtle selection. Portrait/narrow windows use a Notes sheet; landscape sidebar can collapse.
- `FeedbackFix-1.xcresult`: **10 focused tests passed**, zero failures/skips (highlight decoding/geometry/405 handling + reader regression tests).
- `FeedbackUI-2.xcresult`: UI fixture test passed; inspected rendered screenshot `artifacts/reader-feedback-landscape.png` and confirmed visible text highlight and Notes. An earlier screenshot harness produced a black image; attaching its window to the active scene fixed capture. Fixture screenshots are not evidence of the user's particular document or hardware Pencil behavior.
- Desktop LaunchAgent build run 2 exited 0; signature verification passed. `devicectl` installed the update on the connected physical iPad and launched it successfully (installation sequence 1652).
- Existing local data/outbox retained. User needs to sign in after the app restart, reopen the paper and allow pending sync. Actual completion of their queued writes and subjective UI acceptance remain user-visible checks.

## Gamma-native rewrite — historical evidence

The import-only prototype is superseded by Gamma login/library/page identity, grouped ink blocks, annotation text/child notes, and an account-scoped durable outbox. Earlier screenshots/counts below describe the prototype, not the current UI.

- `GammaNative-2.xcresult`: **36 simulator tests passed, zero failures/skips**, confirmed with xcresulttool. Includes native cache/workspace, reader block isolation and native note integration.
- `GammaWire-1.xcresult`: **1 focused URLProtocol test passed**, verifying authenticated username headers and stable UUID PUT `/note` retry addressing under a deployment prefix. This is a mocked network transport, not a live server round-trip.
- Backend full-suite latest reported result: **478 passed** after nested native-note support; parent independently ran preceding 477-case suite successfully.
- Web: 42 tests and production build passed; ink preview changes passed targeted ESLint.
- **Physical deployment succeeded via GUI LaunchAgent**: SSH triggered `gui/501/com.gamma.ipad.agent-build`, Xcode build exited 0, `codesign --verify --deep --strict` passed, `devicectl` installed `com.gamma.pdfnotes.ipad` and launched it on the connected physical iPad. Direct SSH signing failed earlier, but running the build in the existing desktop login session resolved that issue without changing keychain ACLs or storing passwords. The agent is manually triggered, not scheduled; see `scripts/MAC_BUILD_AGENT.md`.
- The selected Personal Team is preserved through ignored `project.local.yml`; regenerate on this Mac using that overlay, not bare `project.yml`. No private key/password or keychain ACL changes were made.
- `GammaLive-3.xcresult`: **1 live backend integration test passed**, confirmed with xcresulttool. An Apple simulator generated real PKDrawing/PNG data; GammaAPI authenticated to a disposable real FastAPI backend through a test-only SSH loopback bridge, created one ink block, retried without duplicate/revision increment, saved annotation text plus nested note blocks, then used a fresh authenticated API client to restore identical ink/PNG bytes and the note tree. Two prior attempts exposed test-harness compile/cookie-forwarding problems, both corrected. Production HTTPS checks were not weakened. This is not a TLS deployment or full app UI/process-relaunch test.
- `GammaOutbox-1.xcresult`: focused workspace tests passed after fixing nested-note parent-first ordering when a later parent edit reorders coalesced mutations. Login/open now permit immediate sync rather than waiting for the periodic retry.
- Reproduction: `scripts/LIVE_TEST.md`; temporary server and SSH tunnel were stopped after the successful live test.
- Remaining: full UI/process-relaunch outbox validation and physical Pencil acceptance. `GammaLive-4.xcresult` extended workspace test failed comparing a reserialized PKDrawing archive (328 vs 306 bytes); semantic stroke equivalence still needs examination, so this failure is not dismissed as harmless and is not yet proof of lost strokes. The implementation is not declared complete on these test results alone.

## Verified (prototype history)

1. Generated project using XcodeGen.
2. `xcodebuild test` with `CODE_SIGNING_ALLOWED=NO`: **19 tests passed, zero failures** (15 NoteStoreTests, 4 GammaAPITests).
3. Installed and launched the compiled application using `simctl`; inspected the settled library screenshot. The initial immediate-launch screenshot captured the launch transition, not the rendered library.
4. XCTest results on Mac: `~/gamma-ipad-agent/TestResults-1.xcresult`.
5. Library screenshot on Mac: `~/gamma-ipad-agent/library-ready.png`.

The storage tests exercise real PDFKit and PencilKit archives, including reopen, page isolation, empty erasure persistence, corruption refusal and immutable PDF sources. They do not synthesize physical Pencil input.

## Expanded reader integration run

`TestResults-2.xcresult` passed with **23 tests, zero failures, zero skipped**, verified using `xcresulttool get test-results summary`: the initial 19 plus four `ReaderIntegrationTests`.

The added tests use real UIKit/PDFKit/PencilKit and explicitly invoke provider/delegate callbacks. They cover overlay cache/eviction/reload and page-index isolation, end-display capture, saving a cleared drawing, protecting corrupt-load pages against every exercised write path, and canonical PKDrawing preservation under actual PDFView zoom/window layout. They intentionally do not claim automatic PDFKit virtualization, pixel-perfect rotated-page alignment or real touch input coverage.

The inspected library screenshot is also saved in this checkout at `artifacts/library-ready.png`.

## Physical-device signing

An actual build was attempted with the connected iPad destination and `-allowProvisioningUpdates -allowProvisioningDeviceRegistration`.

Result: **build failed (65): Signing for GammaIPad requires a development team.**

The initial SSH session reported zero valid code-signing identities and no cached development team identifiers in Xcode preferences. This did not contradict the user having logged into Xcode and did not establish that a paid developer membership was needed.

After the user selected their Personal Team in Xcode, the existing generated project's build settings correctly included a development team and automatic signing. The project was not regenerated, preserving the user's settings. A new device build progressed through compilation but failed at CodeSign of `GammaIPad.debug.dylib` with **errSecInternalComponent** (exit 65).

Follow-up: `security find-identity -v -p codesigning` now finds **one valid Apple Development identity**, but `security show-keychain-info` for the login keychain reports **User interaction is not allowed** over SSH. The remaining issue is keychain access/authorization in the remote session, not a missing paid membership. Local keychain unlock and potentially authorization for codesign are needed before retrying. No Apple ID password, session token or private key was read/exported, and keychain access controls were not changed.

## Warnings and remaining checks

- Xcode 26 emits a PDFPageOverlayViewProvider main-actor conformance warning in Swift 5 mode. It is a warning for this build, but requires attention before adopting Swift 6 language mode.
- No physical-device app installation yet; no real Pencil strokes, palm rejection, pressure, input latency or mixed finger/Pencil gesture validation.
- No live Gamma server account was provided, so network tests cover models/validation/redirect rules, not an authenticated server round-trip.
- No claim of power-loss durability or real low-storage recovery.

## Build-tool installation note

Homebrew installed XcodeGen successfully. Its automatic maintenance also updated taps/cleaned caches and attempted to reinstall `pkgconf`; that unrelated link step reported existing `pkg-config` symlinks. No force-link/unlink or tap-trust changes were made. XcodeGen itself was verified working; the unrelated Homebrew warning did not block the app build.
